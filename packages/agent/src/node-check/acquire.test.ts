import type {FetchLike} from './acquire';
import type {NodeCheckConfigStore} from './config';
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { acquire  } from './acquire'
import { createNodeCheckConfigStore  } from './config'

const SUBSCRIPTION = 'proxies:\n  - name: node-1\n    type: ss\n'

function response(
  body: string,
  init: { status?: number; url?: string } = {},
): Response {
  const result = new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/plain' },
  })
  if (init.url !== undefined) {
    Object.defineProperty(result, 'url', { value: init.url })
  }
  return result
}

function fetchSequence(responses: Array<Response | Error>): {
  fetch: FetchLike
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let index = 0
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = responses[index++] ?? responses.at(-1)
    if (!next) throw new Error('missing response')
    if (next instanceof Error) throw next
    return next
  })
  return { fetch, calls }
}

async function storeWith(
  mutate: Parameters<NodeCheckConfigStore['writeConfig']>[0],
): Promise<NodeCheckConfigStore> {
  const dir = mkdtempSync(join(tmpdir(), 'mcxd-node-check-acquire-'))
  const store = createNodeCheckConfigStore({ dir })
  await store.writeConfig(mutate)
  return store
}

describe('acquire subscription', () => {
  it('fetches direct URLs with plain fetch', async () => {
    const { fetch, calls } = fetchSequence([response(SUBSCRIPTION)])
    const url = 'https://sub.example.com/token-abc?token=secret'

    const result = await acquire(url, { mode: 'direct' }, { fetch })

    expect(result).toEqual({
      content: SUBSCRIPTION,
      finalUrl: url,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(url)
  })

  it('uses the configured general proxy and selected proxy id', async () => {
    const { fetch, calls } = fetchSequence([response(SUBSCRIPTION)])
    const dispatcher = Symbol('http-proxy-dispatcher')
    const createDispatcher = vi.fn(async () => dispatcher)
    const store = await storeWith((config) => {
      config.generalProxy = 'http://127.0.0.1:7890'
      config.githubProxies = [
        {
          id: 'proxy-http',
          prefix: 'http://127.0.0.1:7890',
          enabled: true,
        },
      ]
    })

    const result = await acquire(
      'https://sub.example.com/sub',
      { mode: 'generalProxy', proxyId: 'proxy-http' },
      { fetch, configStore: store, createDispatcher },
    )

    expect(result.content).toBe(SUBSCRIPTION)
    expect(createDispatcher).toHaveBeenCalledWith('http://127.0.0.1:7890')
    expect(calls[0]?.init).toEqual({ dispatcher })
  })

  it('uses a config-selected general proxy when no proxy id is given', async () => {
    const { fetch, calls } = fetchSequence([response(SUBSCRIPTION)])
    const store = await storeWith((config) => {
      config.generalProxy = 'socks5://127.0.0.1:1080'
    })
    const createDispatcher = vi.fn(async () => Symbol('socks-dispatcher'))

    await acquire(
      'https://sub.example.com/sub',
      { mode: 'generalProxy' },
      { fetch, configStore: store, createDispatcher },
    )

    expect(createDispatcher).toHaveBeenCalledWith('socks5://127.0.0.1:1080')
    expect(calls[0]?.init).toHaveProperty('dispatcher')
  })

  it('rejects general proxy mode without a configured proxy', async () => {
    const { fetch } = fetchSequence([])
    const store = await storeWith(() => {})

    await expect(
      acquire(
        'https://sub.example.com/sub',
        { mode: 'generalProxy' },
        { fetch, configStore: store },
      ),
    ).rejects.toThrow(/general proxy.*not configured/i)
  })

  it('uses the stable github proxy id and prefix from config', async () => {
    const { fetch, calls } = fetchSequence([response(SUBSCRIPTION)])
    const store = await storeWith((config) => {
      config.githubProxies = [
        {
          id: 'stable-mirror-1',
          prefix: 'https://mirror.example.net/',
          enabled: true,
        },
      ]
    })

    const result = await acquire(
      'https://sub.example.com/sub',
      { mode: 'githubProxy', proxyId: 'stable-mirror-1' },
      { fetch, configStore: store },
    )

    expect(result.content).toBe(SUBSCRIPTION)
    expect(calls[0]?.url).toBe(
      'https://mirror.example.net/https://sub.example.com/sub',
    )
  })

  it('fails over across enabled github proxies in configured order', async () => {
    const { fetch, calls } = fetchSequence([
      new Error('mirror down'),
      response(SUBSCRIPTION),
    ])
    const store = await storeWith((config) => {
      config.githubProxies = [
        { id: 'disabled', prefix: 'https://off.example/', enabled: false },
        { id: 'mirror-a', prefix: 'https://a.example/', enabled: true },
        { id: 'mirror-b', prefix: 'https://b.example/', enabled: true },
      ]
    })

    const result = await acquire(
      'https://sub.example.com/sub',
      { mode: 'githubProxy' },
      { fetch, configStore: store },
    )

    expect(result.content).toBe(SUBSCRIPTION)
    expect(calls.map((call) => call.url)).toEqual([
      'https://a.example/https://sub.example.com/sub',
      'https://b.example/https://sub.example.com/sub',
    ])
  })

  it('does not silently fall back to direct when mirrors fail', async () => {
    const { fetch, calls } = fetchSequence([new Error('mirror down')])
    const store = await storeWith((config) => {
      config.githubProxies = [
        { id: 'mirror-a', prefix: 'https://a.example/', enabled: true },
      ]
    })

    await expect(
      acquire(
        'https://sub.example.com/sub',
        { mode: 'githubProxy' },
        { fetch, configStore: store },
      ),
    ).rejects.toThrow(/github proxy/i)

    expect(calls.map((call) => call.url)).toEqual([
      'https://a.example/https://sub.example.com/sub',
    ])
  })

  it('allows direct fallback only when explicitly configured', async () => {
    const { fetch, calls } = fetchSequence([
      new Error('mirror down'),
      response(SUBSCRIPTION),
    ])
    const store = await storeWith((config) => {
      config.githubProxies = [
        { id: 'mirror-a', prefix: 'https://a.example/', enabled: true },
      ]
    })

    const result = await acquire(
      'https://sub.example.com/sub',
      { mode: 'githubProxy' },
      { fetch, configStore: store, allowDirectFallback: true },
    )

    expect(result.content).toBe(SUBSCRIPTION)
    expect(calls.map((call) => call.url)).toEqual([
      'https://a.example/https://sub.example.com/sub',
      'https://sub.example.com/sub',
    ])
  })

  it('rejects html error pages and empty bodies', async () => {
    const html = fetchSequence([
      response('<html><body>404 Not Found</body></html>'),
      response('   '),
    ])

    await expect(
      acquire(
        'https://sub.example.com/sub',
        { mode: 'direct' },
        { fetch: html.fetch },
      ),
    ).rejects.toThrow(/html/i)

    const empty = fetchSequence([response('')])
    await expect(
      acquire(
        'https://sub.example.com/sub',
        { mode: 'direct' },
        { fetch: empty.fetch },
      ),
    ).rejects.toThrow(/empty/i)
  })

  it('rejects non-ok http status', async () => {
    const { fetch } = fetchSequence([
      response('<html>forbidden</html>', { status: 403 }),
    ])

    await expect(
      acquire('https://sub.example.com/sub', { mode: 'direct' }, { fetch }),
    ).rejects.toThrow(/HTTP 403/)
  })

  it('rejects private and non-http hosts before fetching', async () => {
    const { fetch, calls } = fetchSequence([])
    const hosts = [
      'http://127.0.0.1/sub',
      'http://localhost/sub',
      'http://10.0.0.1/sub',
      'http://192.168.1.1/sub',
      'http://[::1]/sub',
      'file:///etc/passwd',
    ]

    for (const url of hosts) {
      await expect(acquire(url, { mode: 'direct' }, { fetch })).rejects.toThrow(
        /host|scheme/i,
      )
    }
    expect(calls).toHaveLength(0)
  })

  it('validates every redirect target', async () => {
    const { fetch, calls } = fetchSequence([
      response('', { url: 'http://127.0.0.1/redirect' }),
    ])

    await expect(
      acquire('https://sub.example.com/sub', { mode: 'direct' }, { fetch }),
    ).rejects.toThrow(/host/i)
    expect(calls).toHaveLength(1)
  })

  it('uses the final response url after redirects', async () => {
    const finalUrl = 'https://cdn.example.net/subscriptions/abc?sig=123'
    const { fetch } = fetchSequence([response(SUBSCRIPTION, { url: finalUrl })])

    const result = await acquire(
      'https://sub.example.com/sub',
      { mode: 'direct' },
      { fetch },
    )

    expect(result.finalUrl).toBe(finalUrl)
  })

  it('redacts token-like query values in error messages', async () => {
    const url =
      'https://sub.example.com/sub?token=super-secret&access_key=another-secret'
    const { fetch } = fetchSequence([new Error(`connect ${url} failed`)])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(acquire(url, { mode: 'direct' }, { fetch })).rejects.toThrow(
        /\[redacted\]/,
      )

      const errorText = errorSpy.mock.calls
        .flat()
        .map((value) => String(value))
        .join('\n')
      expect(errorText).not.toContain('super-secret')
      expect(errorText).not.toContain('another-secret')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('redacts token-like values in logged urls', async () => {
    const url = 'https://sub.example.com/sub?token=super-secret'
    const { fetch } = fetchSequence([response(SUBSCRIPTION)])
    const logSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    try {
      await acquire(url, { mode: 'direct' }, { fetch, log: console.debug })
      const logText = logSpy.mock.calls
        .flat()
        .map((value) => String(value))
        .join('\n')
      expect(logText).not.toContain('super-secret')
      expect(logText).toContain('[redacted]')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('fails clearly when the config store is missing for proxy modes', async () => {
    const { fetch } = fetchSequence([])

    await expect(
      acquire(
        'https://sub.example.com/sub',
        { mode: 'githubProxy' },
        { fetch },
      ),
    ).rejects.toThrow(/config store/i)
  })
})
