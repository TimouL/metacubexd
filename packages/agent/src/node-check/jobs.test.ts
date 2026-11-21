import type { NodeCheckConfig } from './config'
import type { DetectionOptions, DetectionResult } from './detect'
import type {ApplyFn, DetectFn, JobManagerOptions, JobRequest, StoredJob} from './jobs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_NODE_CHECK_CONFIG } from './config'
import {
  
  createJobManager,
  
  fingerprintConfig,
  getNodeCheckJobsPath,
  JOB_STATES,
  
  
  normalizeJobStatus
  
} from './jobs'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcxd-node-check-jobs-'))
}

function result(name = 'node-1'): DetectionResult {
  return {
    nodes: [],
    classes: { ai: [], streaming: [], download: [] },
    yaml: {
      ai: `proxies:\n  - name: ${name}\n`,
      streaming: 'proxies: []\n',
      download: 'proxies: []\n',
    },
  }
}

function config(overrides: Partial<NodeCheckConfig> = {}): NodeCheckConfig {
  return {
    ...structuredClone(DEFAULT_NODE_CHECK_CONFIG),
    ...overrides,
  }
}

function request(overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    subscriptionIds: ['sub-1'],
    fingerprint: 'version-1',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function clock() {
  let now = 1_000
  const timers: Array<{
    at: number
    fn: () => void
    handle: ReturnType<typeof setTimeout>
  }> = []
  return {
    now: () => now,
    setNow(value: number) {
      now = value
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timers.splice(timers.indexOf(timer), 1)
          timer.fn()
        }
      }
    },
    setTimeout(fn: () => void, ms: number) {
      const handle = setTimeout(() => {}, 1_000_000)
      handle.unref?.()
      const timer = { at: now + ms, fn, handle }
      timers.push(timer)
      return handle
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
      const index = timers.findIndex((timer) => timer.handle === handle)
      if (index >= 0) {
        clearTimeout(timers[index]!.handle)
        timers.splice(index, 1)
      }
    },
    cancelAll() {
      for (const timer of timers) clearTimeout(timer.handle)
      timers.length = 0
    },
  }
}

async function frozenYaml(): Promise<string> {
  return 'proxies: []\n'
}

interface Harness {
  dir: string
  manager: ReturnType<typeof createJobManager>
  detect: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  fakeClock: ReturnType<typeof clock>
  opts: JobManagerOptions
}

function harness(
  overrides: Partial<JobManagerOptions> = {},
  initialConfig = config(),
): Harness {
  const dir = tempDir()
  const fakeClock = clock()
  const detect = vi.fn<DetectFn>()
  const apply = vi.fn<ApplyFn>()
  const opts: JobManagerOptions = {
    dir,
    advanceTime: (ms: number) => fakeClock.setNow(fakeClock.now() + ms),
    now: fakeClock.now,
    setTimeout: fakeClock.setTimeout,
    clearTimeout: fakeClock.clearTimeout,
    loadProxies: vi.fn(async () => []),
    buildFrozenYaml: vi.fn(frozenYaml),
    detect,
    apply,
    loadConfig: vi.fn(async () => structuredClone(initialConfig)),
    ...overrides,
  }
  return {
    dir,
    manager: createJobManager(opts),
    detect,
    apply,
    fakeClock,
    opts,
  }
}

describe('job status normalization', () => {
  it('defines all states and gives unknown/expired ids a clear response', () => {
    expect(JOB_STATES).toEqual([
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled',
    ])
    expect(
      normalizeJobStatus({ id: 'missing', error: 'Job not found' }),
    ).toMatchObject({
      id: 'missing',
      state: 'failed',
      error: 'Job not found',
      expired: true,
    })
  })

  it('rejects invalid persisted records and clamps progress', () => {
    expect(normalizeJobStatus(null)).toBeUndefined()
    expect(normalizeJobStatus({ id: '', state: 'running' })).toBeUndefined()
    expect(normalizeJobStatus({ id: '1', state: 'bogus' })).toMatchObject({
      expired: true,
    })
    expect(
      normalizeJobStatus({
        id: '1',
        state: 'running',
        progress: Number.NaN,
      })?.progress,
    ).toBe(0)
    expect(
      normalizeJobStatus({ id: '1', state: 'running', progress: 500 })
        ?.progress,
    ).toBe(100)
  })
})

describe('fingerprintConfig', () => {
  it('changes when subscriptions, tags, settings, or transport change', () => {
    const base = fingerprintConfig(config())
    expect(fingerprintConfig(config())).toBe(base)
    expect(fingerprintConfig(config({ tags: { 'sub-1': 'free组' } }))).not.toBe(
      base,
    )
    expect(
      fingerprintConfig(
        config({
          settings: { ...DEFAULT_NODE_CHECK_CONFIG.settings, minSpeedBytes: 1 },
        }),
      ),
    ).not.toBe(base)
    expect(
      fingerprintConfig(
        config({
          refreshTransport: {
            'sub-1': { mode: 'generalProxy', proxyId: 'proxy-1' },
          },
        }),
      ),
    ).not.toBe(base)
  })
})

describe('jobManager lifecycle', () => {
  it('starts one active job, returns an id, and rejects duplicate starts', async () => {
    const { manager, detect } = harness()
    const gate = deferred<DetectionResult>()
    detect.mockReturnValue(gate.promise)

    const first = await manager.start(request())
    const duplicate = await manager.start(request())

    expect(first).toMatch(/^[a-f0-9-]+$/)
    expect(duplicate).toBe(first)
    expect(detect).toHaveBeenCalledTimes(1)
    expect(await manager.getStatus(first)).toMatchObject({
      id: first,
      state: 'running',
    })
    expect((await manager.list()).map((job) => job.id)).toEqual([first])

    gate.resolve(result())
    await vi.waitFor(async () => {
      expect((await manager.getStatus(first))?.state).toBe('completed')
    })
  })

  it('stores only a result reference and makes apply idempotent', async () => {
    const { manager, detect, apply } = harness()
    const detection = result()
    detect.mockResolvedValue(detection)
    apply.mockResolvedValue({ generation: 7 })

    const id = await manager.start(
      request({ fingerprint: fingerprintConfig(config()) }),
    )
    await vi.waitFor(async () => {
      expect((await manager.getStatus(id))?.state).toBe('completed')
    })
    const status = await manager.getStatus(id)
    expect(status?.resultId).toEqual(expect.any(String))
    expect(status).not.toHaveProperty('result', detection)
    expect(status).not.toHaveProperty('result.yaml', detection.yaml)

    expect(await manager.apply(id)).toEqual({ generation: 7 })
    expect(await manager.apply(id)).toEqual({ generation: 7 })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]?.[0]).toBe(status?.resultId)
    expect(apply.mock.calls[0]?.[1]).toMatchObject({
      subscriptionIds: ['sub-1'],
    })
  })

  it('rejects apply when the fingerprint changed since job start', async () => {
    let currentConfig = config()
    const { manager, detect, apply } = harness(
      {
        loadConfig: vi.fn(async () => structuredClone(currentConfig)),
      },
      currentConfig,
    )
    detect.mockResolvedValue(result())
    apply.mockResolvedValue({ generation: 7 })

    const id = await manager.start(request())
    await vi.waitFor(async () => {
      expect((await manager.getStatus(id))?.state).toBe('completed')
    })
    currentConfig = config({ tags: { 'sub-1': 'changed' } })

    await expect(manager.apply(id)).rejects.toThrow(/stale/i)
    expect(apply).not.toHaveBeenCalled()
    expect((await manager.getStatus(id))?.state).toBe('completed')
  })

  it('rejects apply when the current fingerprint does not match the job request', async () => {
    let staleNow = false
    const { manager, detect, apply } = harness({
      loadConfig: vi.fn(async () =>
        staleNow ? config({ tags: { 'sub-1': 'changed' } }) : config(),
      ),
    })
    detect.mockResolvedValue(result())
    const id = await manager.start(
      request({ fingerprint: fingerprintConfig(config()) }),
    )
    await vi.waitFor(async () => {
      expect((await manager.getStatus(id))?.state).toBe('completed')
    })
    staleNow = true

    await expect(manager.apply(id)).rejects.toThrow(/stale/i)
    expect(apply).not.toHaveBeenCalled()
  })

  it('cancels an active job and clears the active slot', async () => {
    const gate = deferred<DetectionResult>()
    const abortSignal = vi.fn()
    const { manager } = harness({
      detect: vi.fn((_frozen: string, opts?: DetectionOptions) => {
        opts?.signal?.addEventListener('abort', abortSignal)
        return gate.promise
      }),
    })

    const id = await manager.start(request())
    expect(await manager.cancel(id)).toBe(true)
    expect(abortSignal).toHaveBeenCalledTimes(1)
    expect(await manager.getStatus(id)).toMatchObject({
      id,
      state: 'cancelled',
      progress: 100,
    })

    gate.reject(new Error('Detection aborted'))
    await vi.waitFor(async () => {
      const second = await manager.start(
        request({ subscriptionIds: ['sub-2'] }),
      )
      expect(second).not.toBe(id)
    })
  })

  it('fails the job when detection rejects and exposes the error', async () => {
    const { manager, detect } = harness()
    detect.mockRejectedValue(new Error('NekoSpeed exited with code 1'))

    const id = await manager.start(request())
    await vi.waitFor(async () => {
      expect((await manager.getStatus(id))?.state).toBe('failed')
    })
    expect(await manager.getStatus(id)).toMatchObject({
      state: 'failed',
      error: 'NekoSpeed exited with code 1',
    })
    expect(await manager.cancel(id)).toBe(false)
  })

  it('enforces an injected deadline and aborts detection', async () => {
    const gate = deferred<DetectionResult>()
    let deadlineSignal: AbortSignal | undefined
    const { manager, fakeClock } = harness({
      detect: vi.fn((_frozen: string, opts?: DetectionOptions) => {
        deadlineSignal = opts?.signal
        return gate.promise
      }),
      defaultTimeoutMs: 250,
    })

    const id = await manager.start(request())
    fakeClock.setNow(1_249)
    expect(deadlineSignal?.aborted).toBe(false)
    fakeClock.setNow(1_250)

    await vi.waitFor(async () => {
      expect((await manager.getStatus(id))?.state).toBe('failed')
    })
    expect(deadlineSignal?.aborted).toBe(true)
    expect((await manager.getStatus(id))?.error).toMatch(/timed out/i)
  })

  it('shutdown aborts the active subprocess controller', async () => {
    const gate = deferred<DetectionResult>()
    let shutdownSignal: AbortSignal | undefined
    const { manager } = harness({
      detect: vi.fn((_frozen: string, opts?: DetectionOptions) => {
        shutdownSignal = opts?.signal
        return gate.promise
      }),
    })

    const id = await manager.start(request())
    await manager.shutdown()
    expect(shutdownSignal?.aborted).toBe(true)
    expect(await manager.getStatus(id)).toMatchObject({
      state: 'cancelled',
      error: 'shutdown',
    })

    gate.reject(new Error('Detection aborted'))
    await Promise.resolve()
  })

  it('returns a clear response for an unknown job id', async () => {
    const { manager } = harness()
    expect(await manager.getStatus('does-not-exist')).toMatchObject({
      id: 'does-not-exist',
      state: 'failed',
      expired: true,
      error: 'Job not found',
    })
    await expect(manager.apply('does-not-exist')).rejects.toThrow(/not found/i)
    expect(await manager.cancel('does-not-exist')).toBe(false)
  })
})

describe('bounded retention and persistence', () => {
  it('expires old jobs and their results beyond the configured cap', async () => {
    const { manager, detect } = harness({
      maxCompletedJobs: 2,
      now: (() => {
        let value = 1000
        return () => value++
      })(),
      defaultTimeoutMs: 1000000,
    })
    detect.mockResolvedValue(result())
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const id = await manager.start(
        request({ subscriptionIds: [`sub-${index}`] }),
      )
      ids.push(id)
      await vi.waitFor(async () => {
        const current = await manager.getStatus(id)
        expect(
          current?.state === 'completed' || current?.error === 'Job expired',
        ).toBe(true)
      })
    }

    const retained = (await manager.list()).map((job) => job.id)
    const evicted = ids.find((id) => !retained.includes(id))!
    expect(retained).toHaveLength(2)
    expect(await manager.getStatus(evicted)).toMatchObject({
      expired: true,
      error: 'Job expired',
    })
    await expect(manager.apply(evicted)).rejects.toThrow(/expired/i)
  })

  it('persists bounded completed results and reconnects after restart', async () => {
    const first = harness({
      maxCompletedJobs: 2,
      now: (() => {
        let value = 1000
        return () => value++
      })(),
      defaultTimeoutMs: 1000000,
    })
    first.detect.mockImplementation(async () =>
      result(`node-${first.detect.mock.calls.length}`),
    )
    const firstIds: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const id = await first.manager.start(
        request({ subscriptionIds: [`sub-${index}`] }),
      )
      firstIds.push(id)
      await vi.waitFor(async () => {
        const current = await first.manager.getStatus(id)
        expect(
          current?.state === 'completed' || current?.error === 'Job expired',
        ).toBe(true)
      })
    }
    await first.manager.flush()

    const persisted = JSON.parse(
      readFileSync(join(first.dir, 'node-check-jobs.json'), 'utf8'),
    ) as { jobs: StoredJob[]; results: Record<string, DetectionResult> }
    expect(persisted.jobs).toHaveLength(2)
    expect(Object.keys(persisted.results)).toHaveLength(2)
    expect(JSON.stringify(persisted.results)).not.toContain('raw-large-result')

    const second = harness({
      dir: first.dir,
      maxCompletedJobs: 2,
      loadConfig: vi.fn(async () => {
        const loader = first.opts.loadConfig
        const loaded = loader ? await loader() : config()
        return loaded
      }),
    })
    expect((await second.manager.getStatus(firstIds[1]!))?.state).toBe(
      'completed',
    )
    await expect(second.manager.apply(firstIds[1]!)).resolves.toBeUndefined()
    expect(second.apply).toHaveBeenCalledTimes(1)
    const secondStatus = await second.manager.getStatus(firstIds[1]!)
    expect(secondStatus?.state).toBe('completed')
  })

  it('ignores corrupt persisted state and writes a persistent file path helper', async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'node-check-jobs.json'), '{not json')
    const { manager } = harness({ dir })

    expect(getNodeCheckJobsPath(dir)).toBe(join(dir, 'node-check-jobs.json'))
    await expect(manager.list()).resolves.toEqual([])
  })
})
