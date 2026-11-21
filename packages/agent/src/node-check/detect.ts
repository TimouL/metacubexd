import type { ChildProcess } from 'node:child_process'
import type { NodeCheckClass } from './config'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'

export const NEKOSPEED_DEFAULT_BINARY = '/usr/local/bin/nekospeed'
export const NEKOSPEED_FONT = '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc'
export const DOWNLOAD_THRESHOLD_BYTES = 1_048_576

export const DEFAULT_DETECTION_LIMITS: DetectionLimits = {
  maxDuration: 30,
  maxThreads: 16,
  maxConcurrency: 16,
  maxNodes: 300,
  timeoutMs: 15 * 60 * 1000,
}

export type DetectionResultClass = NodeCheckClass | 'discard'
export type Aliveness = 'alive' | 'dead' | 'unknown'
export type CapabilityStatus =
  'unlock' | 'pending' | 'senttocn' | 'failed' | 'reqfailed' | 'na' | 'missing'

export interface DetectionLimits {
  maxDuration: number
  maxThreads: number
  maxConcurrency: number
  maxNodes: number
  timeoutMs: number
}

export interface CapabilityResult {
  platform: string
  status: CapabilityStatus
  region?: string
  info?: string
}

export interface DetectionNode {
  index: number
  name: string
  type?: string
  server?: string
  error?: string
  latency: {
    avgHTTPS?: number
    avgTlsRTT?: number
    packetLoss?: number
  }
  speed: {
    avg?: number
    max?: number
    perSecond?: unknown[]
  }
  media: CapabilityResult[]
  ai: CapabilityResult[]
  inbound?: Record<string, unknown>
  outbound?: Record<string, unknown>
}

export interface DetectionJson {
  nodes: DetectionNode[]
  inbound?: Record<string, unknown>
  outbound?: Record<string, unknown>
}

export interface ClassifiedNode extends DetectionNode {
  class: DetectionResultClass
  aliveness: Aliveness
  proxy?: Record<string, unknown>
  renamed?: string
}

export interface FrozenInput {
  content: string
  tempNames: string[]
  proxiesByTempName: Map<string, Record<string, unknown>>
  subscriptionByTempName?: Map<string, string>
}

export interface FrozenInputOptions {
  subscriptionId?: string
}

export interface DetectionResult {
  nodes: ClassifiedNode[]
  classes: Record<NodeCheckClass, ClassifiedNode[]>
  yaml: Record<NodeCheckClass, string>
  subscriptionIds?: string[]
  subscriptionByTempName?: Record<string, string>
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    stdio: ['ignore', 'pipe', 'pipe']
  },
) => ChildProcess

export type ParseResultLike = (resultPath: string) => Promise<unknown>

export interface DetectionOptions {
  tag?: string
  binaryPath?: string
  fontPath?: string
  tempDir?: string
  duration?: number
  threads?: number
  concurrency?: number
  timeoutMs?: number
  limits?: Partial<DetectionLimits>
  signal?: AbortSignal
  log?: (message: string) => void
  spawn?: SpawnLike
  parseResult?: ParseResultLike
}

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function cap(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const candidate = value ?? fallback
  if (!Number.isFinite(candidate)) return fallback
  return Math.max(1, Math.min(Math.floor(candidate), maximum))
}

function status(value: unknown): CapabilityStatus {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (
    text === 'unlock' ||
    text === 'pending' ||
    text === 'senttocn' ||
    text === 'failed' ||
    text === 'reqfailed' ||
    text === 'na'
  ) {
    return text
  }
  return 'missing'
}

function capabilities(value: unknown): CapabilityResult[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): CapabilityResult[] => {
    if (!isPlainObject(item)) return []
    return [
      {
        platform: typeof item.platform === 'string' ? item.platform : '',
        status: status(item.status),
        region: typeof item.region === 'string' ? item.region : undefined,
        info: typeof item.info === 'string' ? item.info : undefined,
      },
    ]
  })
}

function normalizeNode(value: unknown, index: number): DetectionNode {
  const node = isPlainObject(value) ? value : {}
  const latency = isPlainObject(node.latency) ? node.latency : {}
  const speed = isPlainObject(node.speed) ? node.speed : {}
  return {
    index: typeof node.index === 'number' ? node.index : index,
    name: typeof node.name === 'string' ? node.name : `__nc_${index + 1}`,
    type: typeof node.type === 'string' ? node.type : undefined,
    server: typeof node.server === 'string' ? node.server : undefined,
    error: typeof node.error === 'string' ? node.error : '',
    latency: {
      avgHTTPS:
        typeof latency.avgHTTPS === 'number' ? latency.avgHTTPS : undefined,
      avgTlsRTT:
        typeof latency.avgTlsRTT === 'number' ? latency.avgTlsRTT : undefined,
      packetLoss:
        typeof latency.packetLoss === 'number' ? latency.packetLoss : undefined,
    },
    speed: {
      avg: typeof speed.avg === 'number' ? speed.avg : undefined,
      max: typeof speed.max === 'number' ? speed.max : undefined,
      perSecond: Array.isArray(speed.perSecond) ? speed.perSecond : undefined,
    },
    media: capabilities(node.media),
    ai: capabilities(node.ai),
    inbound: isPlainObject(node.inbound) ? node.inbound : undefined,
    outbound: isPlainObject(node.outbound) ? node.outbound : undefined,
  }
}

export function normalizeDetectionJson(value: unknown): DetectionJson {
  if (!isPlainObject(value) || !Array.isArray(value.nodes)) {
    throw new Error('Invalid detection result: nodes must be an array')
  }
  return {
    nodes: value.nodes.map(normalizeNode),
    inbound: isPlainObject(value.inbound) ? value.inbound : undefined,
    outbound: isPlainObject(value.outbound) ? value.outbound : undefined,
  }
}

function findStatus(
  items: CapabilityResult[],
  platformPattern: RegExp,
): CapabilityStatus {
  return (
    items.find((item) => platformPattern.test(item.platform.toLowerCase()))
      ?.status ?? 'missing'
  )
}

function hasPositiveMeasurement(node: DetectionNode): boolean {
  return (
    positive(node.speed.avg) ||
    positive(node.speed.max) ||
    positive(node.latency.avgHTTPS) ||
    positive(node.latency.avgTlsRTT) ||
    positive(node.latency.packetLoss)
  )
}

function evaluateAliveness(node: DetectionNode): Aliveness {
  if ((node.error ?? '').trim() !== '') return 'dead'

  const aiStatuses = node.ai.map((item) => item.status)
  const mediaStatuses = node.media.map((item) => item.status)
  const allStatuses = [...aiStatuses, ...mediaStatuses]
  const hasUnlock = allStatuses.includes('unlock')

  if (hasUnlock || hasPositiveMeasurement(node)) return 'alive'
  if (allStatuses.length > 0 && allStatuses.every((item) => item === 'missing'))
    return 'unknown'
  if (allStatuses.includes('reqfailed')) return 'dead'
  return 'alive'
}

export function classNameify(node: DetectionNode): {
  class: DetectionResultClass
  aliveness: Aliveness
} {
  const aliveness = evaluateAliveness(node)
  if (aliveness !== 'alive') return { class: 'discard', aliveness }

  const openai = findStatus(node.ai, /openai|gpt|chatgpt/)
  const youtube = findStatus(node.media, /youtube/)
  if (openai === 'unlock') return { class: 'ai', aliveness }
  if (youtube === 'unlock') return { class: 'streaming', aliveness }
  if ((node.speed.avg ?? 0) >= DOWNLOAD_THRESHOLD_BYTES) {
    return { class: 'download', aliveness }
  }
  return { class: 'discard', aliveness }
}

export function buildFrozenInput(
  proxies: readonly unknown[],
  opts: FrozenInputOptions = {},
): FrozenInput {
  const normalized = proxies.map((proxy) => {
    if (!isPlainObject(proxy))
      throw new Error('Invalid proxy: expected an object')
    return structuredClone(proxy)
  })
  const proxiesByTempName = new Map<string, PlainObject>()
  const subscriptionByTempName = new Map<string, string>()
  const renamed = normalized.map((proxy, index) => {
    const tempName = `__nc_${index + 1}`
    proxiesByTempName.set(tempName, proxy)
    if (opts.subscriptionId) {
      subscriptionByTempName.set(tempName, opts.subscriptionId)
    }
    return { ...proxy, name: tempName }
  })
  const content = stringify({ proxies: renamed }, { lineWidth: 0 })
  return {
    content,
    tempNames: [...proxiesByTempName.keys()],
    proxiesByTempName,
    ...(subscriptionByTempName.size > 0 ? { subscriptionByTempName } : {}),
  }
}

function parseFrozenProxies(content: string): unknown[] {
  const document = parse(content) as PlainObject
  const proxies = document?.proxies
  return Array.isArray(proxies) ? proxies : []
}

function tierFor(speed: number, tiers: readonly number[] = []): string {
  const configured =
    tiers.length > 0
      ? [...tiers].sort((left, right) => left - right)
      : [1_048_576, 3 * 1_048_576, 5 * 1_048_576, 10 * 1_048_576]
  let tier = configured[0] ?? 1_048_576
  for (const candidate of configured) {
    if (speed >= candidate) tier = candidate
  }
  return `${Math.round(tier / 1_048_576)}m`
}

function chineseRegion(value: unknown): string {
  const candidates: string[] = []
  if (isPlainObject(value)) {
    for (const key of ['country', 'countryCode', 'region', 'city']) {
      const item = value[key]
      if (typeof item === 'string') candidates.push(item)
    }
  } else if (typeof value === 'string') {
    candidates.push(value)
  }
  const text = candidates.join(' ').toLowerCase()
  if (/\bus\b|\busa\b|美国|united states/.test(text)) return '美国'
  if (/hk|hong\s*kong|香港/.test(text)) return '香港'
  if (/jp|japan|日本/.test(text)) return '日本'
  if (/sg|singapore|新加坡/.test(text)) return '新加坡'
  return '其他'
}

function capabilityLabel(
  node: ClassifiedNode,
  tiers: readonly number[],
): string {
  if (node.class === 'ai') return 'AI'
  if (node.class === 'streaming') return '流媒体'
  return tierFor(node.speed.avg ?? 0, tiers)
}

export function renameNode(
  node: ClassifiedNode,
  tag: string,
  tiers: readonly number[] = [],
): string {
  const position = node.index >= 0 ? node.index + 1 : 1
  return `${tag}_${chineseRegion(node.outbound)}_${capabilityLabel(node, tiers)}_${position}`
}

export function renderClassYaml(proxies: readonly PlainObject[]): string {
  if (proxies.length === 0) return 'proxies: []\n'
  return stringify(
    { proxies: proxies.map((proxy) => structuredClone(proxy)) },
    { lineWidth: 0 },
  )
}

async function defaultParseResult(resultPath: string): Promise<unknown> {
  const content = await readFile(resultPath, 'utf8')
  return JSON.parse(content)
}

async function prepareWorkingDir(tempDir?: string): Promise<{
  root: string
  owned: boolean
}> {
  if (tempDir) {
    const root = resolve(tempDir)
    await mkdir(root, { recursive: true, mode: 0o700 })
    return { root, owned: false }
  }
  return {
    root: await mkdtemp(join(tmpdir(), 'mcxd-node-check-detect-')),
    owned: true,
  }
}

async function waitForExit(
  child: ChildProcess,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    log?: (message: string) => void
  },
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolvePromise()
    }

    const onAbort = () => {
      child.kill('SIGTERM')
      finish(new Error('Detection aborted'))
    }

    if (options.signal?.aborted) {
      child.kill('SIGTERM')
      finish(new Error('Detection aborted'))
      return
    }

    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      finish(
        new Error(
          `NekoSpeed exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`,
        ),
      )
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        options.log?.('Detection timed out; terminating NekoSpeed')
        child.kill('SIGTERM')
        finish(new Error('Detection timed out'))
      }, options.timeoutMs)
      timer.unref?.()
    }
  })
}

export async function runDetection(
  frozenYamlContent: string,
  opts: DetectionOptions = {},
): Promise<DetectionResult> {
  const limits: DetectionLimits = {
    ...DEFAULT_DETECTION_LIMITS,
    ...opts.limits,
  }
  const { root: workingRoot, owned } = await prepareWorkingDir(opts.tempDir)
  const outDir = join(workingRoot, 'out')
  const configPath = join(workingRoot, 'frozen.yaml')
  const resultPath = join(outDir, 'result.json')

  try {
    await mkdir(outDir, { recursive: true, mode: 0o700 })

    const allFrozenProxies = parseFrozenProxies(frozenYamlContent)
    const frozenInput = buildFrozenInput(
      allFrozenProxies.slice(0, limits.maxNodes),
    )
    await writeFile(configPath, frozenInput.content, { mode: 0o600 })

    const args = [
      '-config',
      configPath,
      '-o',
      outDir,
      '-name',
      'result',
      '-tests',
      'speed,ai,media',
      '-font',
      opts.fontPath ?? NEKOSPEED_FONT,
      '-preflight=false',
      '-duration',
      String(cap(opts.duration, 1, limits.maxDuration)),
      '-threads',
      String(cap(opts.threads, 1, limits.maxThreads)),
      '-concurrency',
      String(cap(opts.concurrency, 1, limits.maxConcurrency)),
    ]

    const spawn = opts.spawn ?? (nodeSpawn as SpawnLike)
    const child = spawn(opts.binaryPath ?? NEKOSPEED_DEFAULT_BINARY, args, {
      cwd: workingRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await waitForExit(child, {
      signal: opts.signal,
      timeoutMs: Math.min(opts.timeoutMs ?? limits.timeoutMs, limits.timeoutMs),
      log: opts.log,
    })

    const parse = opts.parseResult ?? defaultParseResult
    const parsed = normalizeDetectionJson(await parse(resultPath))
    const originals = [...frozenInput.proxiesByTempName.values()]

    const classes: Record<NodeCheckClass, ClassifiedNode[]> = {
      ai: [],
      streaming: [],
      download: [],
    }
    const nodes = parsed.nodes.map((raw, index) => {
      const classification = classNameify(raw)
      const node: ClassifiedNode = { ...raw, ...classification }
      const proxy =
        frozenInput.proxiesByTempName.get(node.name) ??
        originals[node.index] ??
        originals[node.index - 1] ??
        originals[index]
      if (proxy) {
        node.proxy = structuredClone(proxy)
        if (node.class !== 'discard') {
          node.renamed = renameNode(node, opts.tag ?? 'nc')
          node.proxy.name = node.renamed
        }
      }
      if (node.class !== 'discard') classes[node.class].push(node)
      return node
    })

    return {
      nodes,
      classes,
      yaml: {
        ai: renderClassYaml(
          classes.ai.flatMap((node) => (node.proxy ? [node.proxy] : [])),
        ),
        streaming: renderClassYaml(
          classes.streaming.flatMap((node) => (node.proxy ? [node.proxy] : [])),
        ),
        download: renderClassYaml(
          classes.download.flatMap((node) => (node.proxy ? [node.proxy] : [])),
        ),
      },
      ...(frozenInput.subscriptionByTempName
        ? {
            subscriptionByTempName: Object.fromEntries(
              frozenInput.subscriptionByTempName,
            ),
          }
        : {}),
    }
  } finally {
    if (owned) {
      await rm(workingRoot, { recursive: true, force: true })
    } else {
      await rm(configPath, { force: true })
      await rm(outDir, { recursive: true, force: true })
    }
  }
}
