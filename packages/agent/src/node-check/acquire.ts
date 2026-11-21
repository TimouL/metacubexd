import type { NodeCheckConfigStore, RefreshTransport } from './config'

export interface AcquireResult {
  content: string
  finalUrl: string
}

export interface FetchLike {
  (
    url: string | URL,
    init?: RequestInit & { dispatcher?: unknown },
  ): Promise<Response>
}

export type DispatcherFactory = (proxyUrl: string) => Promise<unknown>

export interface AcquireOptions {
  fetch?: FetchLike
  configStore?: NodeCheckConfigStore
  createDispatcher?: DispatcherFactory
  allowDirectFallback?: boolean
  log?: (message: string) => void
}

const SENSITIVE_QUERY_PARAMS = new Set([
  'access_key',
  'access-token',
  'apikey',
  'api_key',
  'auth',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'token',
])

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, '__REDACTED__')
      }
    }
    return url.toString().replaceAll('__REDACTED__', '[redacted]')
  } catch {
    return '[redacted]'
  }
}

function redact(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match))
}

function report(options: AcquireOptions, message: string): void {
  options.log?.(redact(message))
}

function validateUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid subscription URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported subscription URL scheme')
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1'
  ) {
    throw new Error('Private subscription host is not allowed')
  }

  const octets = hostname.split('.').map(Number)
  if (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  ) {
    const [first, second] = octets as [number, number, number, number]
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 192 && second === 0) ||
      (first === 198 && (second === 18 || second === 19))
    ) {
      throw new Error('Private subscription host is not allowed')
    }
  }

  if (
    hostname === '::' ||
    hostname.startsWith('fc') ||
    hostname.startsWith('fd') ||
    hostname.startsWith('fe80')
  ) {
    throw new Error('Private subscription host is not allowed')
  }

  return url
}

function looksLikeHtml(content: string): boolean {
  const head = content.slice(0, 2048).trimStart().toLowerCase()
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    /<head[\s>]/i.test(head)
  )
}

function looksLikeSubscription(content: string): boolean {
  const normalized = content.trimStart().toLowerCase()
  return (
    normalized.startsWith('proxies:') ||
    normalized.startsWith('proxy-providers:') ||
    normalized.startsWith('ss:') ||
    normalized.startsWith('ssr:') ||
    normalized.startsWith('vmess:') ||
    normalized.startsWith('vless:') ||
    normalized.startsWith('trojan:') ||
    normalized.startsWith('hysteria:') ||
    normalized.startsWith('hysteria2:') ||
    /(?:^|\r?\n)\s*-\s*(?:name|type|server):/i.test(content)
  )
}

async function defaultCreateDispatcher(proxyUrl: string): Promise<unknown> {
  throw new Error(
    `No fetch dispatcher is available for general proxy ${redactUrl(proxyUrl)}; provide opts.createDispatcher`,
  )
}

function requestInit(dispatcher: unknown): RequestInit | undefined {
  return dispatcher === undefined ? undefined : ({ dispatcher } as RequestInit)
}

async function fetchSubscription(
  fetchImpl: FetchLike,
  url: string,
  dispatcher?: unknown,
): Promise<AcquireResult> {
  let response: Response
  try {
    response = await fetchImpl(url, requestInit(dispatcher))
  } catch (error) {
    throw new Error(
      redact(error instanceof Error ? error.message : String(error)),
    )
  }

  if (!response.ok) {
    throw new Error(`Subscription request failed with HTTP ${response.status}`)
  }

  const finalUrl = Object.hasOwn(response, 'url')
    ? response.url || url
    : url
  validateUrl(finalUrl)

  const content = await response.text()
  if (content.trim() === '') throw new Error('Subscription content is empty')
  if (looksLikeHtml(content)) {
    throw new Error('Subscription content looks like an HTML error page')
  }
  if (!looksLikeSubscription(content)) {
    throw new Error('Subscription content is not recognized as a subscription')
  }

  return { content, finalUrl }
}

function joinPrefix(prefix: string, url: string): string {
  return `${prefix.replace(/\/+$/, '')}/${url}`
}

async function requireConfigStore(
  options: AcquireOptions,
): Promise<NodeCheckConfigStore> {
  if (!options.configStore) {
    throw new Error('A config store is required for proxy transports')
  }
  return options.configStore
}

async function fetchGeneralProxy(
  url: string,
  transport: RefreshTransport,
  options: AcquireOptions,
  fetchImpl: FetchLike,
): Promise<AcquireResult> {
  const store = await requireConfigStore(options)
  const config = await store.readConfig()
  const proxyUrl =
    (transport.proxyId
      ? config.githubProxies.find(
          (proxy) => proxy.id === transport.proxyId && proxy.enabled,
        )?.prefix
      : undefined) ?? config.generalProxy

  if (!proxyUrl) throw new Error('General proxy is not configured')

  const createDispatcher = options.createDispatcher ?? defaultCreateDispatcher
  const dispatcher = await createDispatcher(proxyUrl)
  report(options, `acquiring ${redactUrl(url)} through general proxy`)
  return fetchSubscription(fetchImpl, url, dispatcher)
}

async function fetchGithubProxy(
  url: string,
  transport: RefreshTransport,
  options: AcquireOptions,
  fetchImpl: FetchLike,
): Promise<AcquireResult> {
  const store = await requireConfigStore(options)
  const config = await store.readConfig()
  const selected = transport.proxyId
    ? config.githubProxies.filter(
        (proxy) => proxy.id === transport.proxyId && proxy.enabled,
      )
    : config.githubProxies.filter((proxy) => proxy.enabled)

  if (selected.length === 0) {
    throw new Error('No enabled GitHub proxy is configured')
  }

  const candidates = selected.map((proxy) => joinPrefix(proxy.prefix, url))
  if (options.allowDirectFallback) candidates.push(url)

  const errors: string[] = []
  for (const candidate of candidates) {
    report(options, `acquiring ${redactUrl(candidate)} through GitHub proxy`)
    try {
      return await fetchSubscription(fetchImpl, candidate)
    } catch (error) {
      errors.push(
        redact(error instanceof Error ? error.message : String(error)),
      )
    }
  }

  throw new Error(`GitHub proxy acquisition failed: ${errors.join('; ')}`)
}

export async function acquire(
  url: string,
  transport: RefreshTransport,
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  const sourceUrl = validateUrl(url)
  const fetchImpl = opts.fetch ?? fetch

  switch (transport.mode) {
    case 'direct':
      report(opts, `acquiring ${redactUrl(sourceUrl.toString())} directly`)
      return fetchSubscription(fetchImpl, sourceUrl.toString())
    case 'generalProxy':
      return fetchGeneralProxy(sourceUrl.toString(), transport, opts, fetchImpl)
    case 'githubProxy':
      return fetchGithubProxy(sourceUrl.toString(), transport, opts, fetchImpl)
    default:
      throw new Error('Unsupported transport mode')
  }
}
