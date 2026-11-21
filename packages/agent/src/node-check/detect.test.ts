import type { ChildProcess } from 'node:child_process'
import type { DetectionLimits, SpawnLike } from './detect'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  buildFrozenInput,
  classNameify,
  DEFAULT_DETECTION_LIMITS,
  renderClassYaml,
  resolveResultPath,
  runDetection,
} from './detect'

interface SpawnCall {
  command: string
  args: readonly string[]
  options: Record<string, unknown>
}

type ChildController = Omit<ChildProcess, 'emit'> & {
  emit: (event: string, ...args: unknown[]) => boolean
  kill: (signal?: NodeJS.Signals) => boolean
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcxd-node-check-detect-'))
}

function child(): ChildController {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const controller = {
    pid: 1234,
    stdin: null,
    stdout: { on: vi.fn(), destroy: vi.fn() },
    stderr: { on: vi.fn(), destroy: vi.fn() },
    stdio: [],
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    connected: false,
    channel: null,
    on(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return controller
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add((...args: unknown[]) => {
        set.delete(listener)
        listener(...args)
      })
      listeners.set(event, set)
      return controller
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener)
      return controller
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener)
      return controller
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
      return true
    },
    kill: vi.fn((signal?: NodeJS.Signals) => {
      queueMicrotask(() => controller.emit('exit', null, signal ?? 'SIGTERM'))
      return true
    }),
    unref: vi.fn(() => controller),
    ref: vi.fn(() => controller),
    disconnect: vi.fn(),
    send: vi.fn(),
    addListener(event: string, listener: (...args: unknown[]) => void) {
      return controller.on(event, listener)
    },
    prependListener(event: string, listener: (...args: unknown[]) => void) {
      return controller.on(event, listener)
    },
    prependOnceListener(event: string, listener: (...args: unknown[]) => void) {
      return controller.once(event, listener)
    },
    removeAllListeners(event?: string) {
      if (event) listeners.delete(event)
      else listeners.clear()
      return controller
    },
    listeners(event: string) {
      return Array.from(listeners.get(event) ?? []) as never[]
    },
    rawListeners(event: string) {
      return controller.listeners(event)
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0
    },
    eventNames() {
      return Array.from(listeners.keys())
    },
    getMaxListeners() {
      return 10
    },
    setMaxListeners() {
      return controller
    },
  } as unknown as ChildController
  return controller
}

function spawnRecorder(controllers: ChildController[] = []) {
  const calls: SpawnCall[] = []
  const spawn = vi.fn(
    (
      command: string,
      args: readonly string[],
      options: Record<string, unknown>,
      emitExit = true,
    ) => {
      calls.push({ command, args, options })
      const controller = controllers.shift() ?? child()
      if (emitExit) queueMicrotask(() => controller.emit('exit', 0, null))
      return controller as never
    },
  ) as unknown as SpawnLike
  return { calls, spawn }
}

function detectionJson(nodes: unknown[]): unknown {
  return {
    nodes,
    inbound: { ip: '1.1.1.1', country: 'US' },
    outbound: { ip: '2.2.2.2', country: 'US' },
  }
}

function rawNode(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    index: 0,
    name: '__nc_1',
    type: 'ss',
    server: 'server.example',
    error: '',
    latency: { avgHTTPS: 0, avgTlsRTT: 0, packetLoss: 0 },
    speed: { avg: 0, max: 0, perSecond: [] },
    media: [],
    ai: [],
    ...overrides,
  }
}

function capabilities(openai: string, youtube?: string): unknown[] {
  return [
    { platform: 'OpenAI', status: openai, region: 'US', info: '' },
    ...(youtube === undefined
      ? []
      : [{ platform: 'YouTube', status: youtube, region: 'US', info: '' }]),
  ]
}

function proxy(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: 'ss',
    server: 'server.example',
    port: 8388,
    cipher: 'aes-256-gcm',
    password: 'secret',
    ...extra,
  }
}

function frozenYaml(proxies: unknown[] = [proxy('original')]): string {
  return `${[
    'proxies:',
    ...proxies.flatMap((item) => [
      `  - ${yamlLines(item as Record<string, unknown>).join('\n    ')}`,
    ]),
  ].join('\n')}\n`
}

function yamlLines(value: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const [key, item] of Object.entries(value)) {
    lines.push(`${key}: ${JSON.stringify(item).replaceAll('"', '')}`)
  }
  return lines
}

describe('buildFrozenInput', () => {
  it('rewrites names to unique temp names and preserves full proxies', () => {
    const original = [
      proxy('duplicate'),
      proxy('duplicate', { type: 'vmess', uuid: 'uuid-1' }),
    ]
    const { content, tempNames, proxiesByTempName } = buildFrozenInput(original)

    expect(tempNames).toEqual(['__nc_1', '__nc_2'])
    expect(proxiesByTempName.get('__nc_2')).toEqual(original[1])
    const doc = parse(content) as { proxies: Array<Record<string, unknown>> }
    expect(doc.proxies.map((item) => item.name)).toEqual(['__nc_1', '__nc_2'])
    expect(doc.proxies[1]).toMatchObject({ type: 'vmess', uuid: 'uuid-1' })
  })
})

describe('classNameify', () => {
  const cases: Array<{
    name: string
    openai: string
    youtube: string
    speed: number
    mediaPlatform?: string
    error?: string
    latency?: number
    expected: string
  }> = [
    {
      name: 'row 1',
      openai: 'pending',
      youtube: 'unlock',
      speed: 1_048_576,
      expected: 'streaming',
    },
    {
      name: 'row 2',
      openai: 'unlock',
      youtube: 'reqfailed',
      speed: 0,
      expected: 'ai',
    },
    {
      name: 'row 3',
      openai: 'reqfailed',
      youtube: 'unlock',
      speed: 0,
      expected: 'streaming',
    },
    {
      name: 'row 4',
      openai: 'pending',
      youtube: 'pending',
      speed: 1_048_576,
      expected: 'download',
    },
    {
      name: 'row 5',
      openai: 'pending',
      youtube: 'pending',
      speed: 0,
      expected: 'discard',
    },
    {
      name: 'row 6',
      openai: 'missing',
      youtube: 'missing',
      speed: 0,
      mediaPlatform: 'Netflix',
      expected: 'discard',
    },
    {
      name: 'row 7',
      openai: 'missing',
      youtube: 'missing',
      speed: 1_048_576,
      mediaPlatform: 'Netflix',
      expected: 'download',
    },
    {
      name: 'row 8',
      openai: 'failed',
      youtube: 'senttocn',
      speed: 0,
      expected: 'discard',
    },
    {
      name: 'row 9',
      openai: 'failed',
      youtube: 'senttocn',
      speed: 1_048_576,
      expected: 'download',
    },
    {
      name: 'row 10',
      openai: 'na',
      youtube: 'na',
      speed: 1_048_576,
      expected: 'download',
    },
    {
      name: 'row 11',
      openai: 'reqfailed',
      youtube: 'reqfailed',
      speed: 1_048_576,
      expected: 'download',
    },
    {
      name: 'row 12',
      openai: 'missing',
      youtube: 'missing',
      speed: 1_048_575,
      expected: 'discard',
    },
    {
      name: 'row 13',
      openai: 'missing',
      youtube: 'missing',
      speed: 1_048_576,
      expected: 'download',
    },
    {
      name: 'row 14',
      openai: 'missing',
      youtube: 'missing',
      speed: 0,
      latency: 12,
      expected: 'discard',
    },
    {
      name: 'row 15',
      openai: 'na',
      youtube: 'reqfailed',
      speed: 0,
      expected: 'discard',
    },
    {
      name: 'row 16',
      openai: 'missing',
      youtube: 'missing',
      speed: 0,
      expected: 'discard',
    },
    {
      name: 'row 17',
      openai: 'unlock',
      youtube: 'unlock',
      speed: 1_048_576,
      error: 'dial tcp: failed',
      expected: 'discard',
    },
  ]

  for (const testCase of cases) {
    it(`${testCase.name}: ${testCase.openai}/${testCase.youtube}/${testCase.speed} -> ${testCase.expected}`, () => {
      const node = rawNode({
        error: testCase.error ?? '',
        latency: {
          avgHTTPS: testCase.latency ?? 0,
          avgTlsRTT: 0,
          packetLoss: 0,
        },
        speed: { avg: testCase.speed, max: testCase.speed, perSecond: [] },
        ai: capabilities(testCase.openai, testCase.youtube),
        media: testCase.mediaPlatform
          ? [
              {
                platform: testCase.mediaPlatform,
                status: 'unlock',
                region: 'US',
                info: '',
              },
            ]
          : capabilities('', testCase.youtube).slice(1),
      })

      const result = classNameify(node as never)

      expect(result.class).toBe(testCase.expected)
      if (testCase.name === 'row 15') expect(result.aliveness).toBe('dead')
      if (testCase.name === 'row 16') expect(result.aliveness).toBe('unknown')
      if (
        ['row 5', 'row 6', 'row 8', 'row 14', 'row 17'].includes(testCase.name)
      ) {
        expect(result.aliveness).toBe(
          testCase.name === 'row 17' ? 'dead' : 'alive',
        )
      }
    })
  }

  it('applies nonqualifying platform rule to Disney+ and Bilibili', () => {
    for (const platform of ['Disney+', 'Bilibili']) {
      expect(
        classNameify(
          rawNode({
            ai: capabilities('missing'),
            media: [{ platform, status: 'unlock', region: 'US', info: '' }],
          }) as never,
        ).class,
      ).toBe('discard')
    }
  })

  it('prioritizes OpenAI unlock over YouTube unlock without fatal error', () => {
    expect(
      classNameify(
        rawNode({
          ai: capabilities('unlock', 'unlock'),
        }) as never,
      ).class,
    ).toBe('ai')
  })
})

describe('runDetection', () => {
  it('spawns with argument array on a frozen private file and parses result JSON', async () => {
    const dir = tempDir()
    const { calls, spawn } = spawnRecorder()
    const content = frozenYaml()
    const parseResult = vi.fn(async (resultPath: string) => {
      expect(resultPath).toContain(join(dir, 'out'))
      return detectionJson([
        rawNode({
          ai: capabilities('unlock', 'pending'),
          outbound: { ip: '2.2.2.2', country: 'US' },
        }),
      ])
    })

    const result = await runDetection(content, {
      tag: 'free组',
      binaryPath: '/custom/nekospeed',
      tempDir: dir,
      spawn,
      parseResult,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('/custom/nekospeed')
    expect(Array.isArray(calls[0]?.args)).toBe(true)
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        '-config',
        expect.stringContaining(dir),
        '-o',
        expect.stringContaining(dir),
        '-name',
        'result',
        '-tests',
        'speed,ai,media',
        '-font',
        '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
        '-preflight=false',
      ]),
    )
    expect(calls[0]?.options).toMatchObject({
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(calls[0]?.args[1]).toContain(dir)
    expect(result.nodes[0]).toMatchObject({
      index: 0,
      name: '__nc_1',
      class: 'ai',
      proxy: { name: 'free组_美国_AI_1', password: 'secret' },
      renamed: 'free组_美国_AI_1',
    })
    expect(result.yaml.ai).toContain('name: free组_美国_AI_1')
    expect(parseResult).toHaveBeenCalledTimes(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses the default binary path and capped configurable limits', async () => {
    const { calls, spawn } = spawnRecorder()
    const parseResult = vi.fn(async () => detectionJson([]))

    await runDetection(frozenYaml(), {
      tempDir: tempDir(),
      spawn,
      parseResult,
      duration: 9999,
      threads: 9999,
      concurrency: 9999,
    })

    const args = calls[0]?.args ?? []
    expect(calls[0]?.command).toBe('/usr/local/bin/nekospeed')
    expect(args).toContain('-duration')
    expect(args).toContain('-threads')
    expect(args).toContain('-concurrency')
    expect(Number(args[args.indexOf('-duration') + 1])).toBeLessThanOrEqual(
      DEFAULT_DETECTION_LIMITS.maxDuration,
    )
    expect(Number(args[args.indexOf('-threads') + 1])).toBeLessThanOrEqual(
      DEFAULT_DETECTION_LIMITS.maxThreads,
    )
    expect(Number(args[args.indexOf('-concurrency') + 1])).toBeLessThanOrEqual(
      DEFAULT_DETECTION_LIMITS.maxConcurrency,
    )
  })

  it('applies node count cap to frozen input', async () => {
    const { spawn } = spawnRecorder()
    const limits: Partial<DetectionLimits> = { maxNodes: 1 }
    const parseResult = vi.fn(async () => detectionJson([]))

    await runDetection(frozenYaml([proxy('one'), proxy('two')]), {
      spawn,
      parseResult,
      limits,
    })

    expect(parseResult).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('kills the child on abort', async () => {
    const controller = child()
    const { spawn } = spawnRecorder([controller])
    const abortController = new AbortController()
    const parseResult = vi.fn(async () => detectionJson([]))

    const promise = runDetection(frozenYaml(), {
      spawn,
      parseResult,
      signal: abortController.signal,
    })
    abortController.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    expect(controller.kill).toHaveBeenCalled()
  })

  it('times out and kills the child', async () => {
    const controller = child()
    const { spawn } = spawnRecorder()
    const mock = spawn as unknown as ReturnType<typeof vi.fn>
    mock.mockImplementation(() => {
      return controller as never
    })
    const parseResult = vi.fn(async () => detectionJson([]))
    const promise = runDetection(frozenYaml(), {
      spawn,
      parseResult,
      timeoutMs: 10,
    })
    const expectation = expect(promise).rejects.toThrow(/timed out/i)
    await expectation
    expect(controller.kill).toHaveBeenCalled()
  })

  it('rejects malformed or missing result JSON', async () => {
    const { spawn } = spawnRecorder()
    await expect(
      runDetection(frozenYaml(), {
        spawn,
        parseResult: async () => {
          throw new Error('missing result JSON')
        },
      }),
    ).rejects.toThrow(/missing result JSON/)

    const { spawn: spawn2 } = spawnRecorder()
    await expect(
      runDetection(frozenYaml(), {
        spawn: spawn2,
        parseResult: async () => ({ nodes: 'not-an-array' }),
      }),
    ).rejects.toThrow(/nodes/i)
  })

  it('renders an empty class as proxies: []', () => {
    expect(renderClassYaml([])).toBe('proxies: []\n')
  })

  it('resolves NekoSpeed timestamped result file over fixed result.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-result-path-'))
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(dir, 'result_20261121_030000_result.json'), '{}')
      const found = await resolveResultPath(dir)
      expect(found).toBe(join(dir, 'result_20261121_030000_result.json'))
      // falls back to fixed path when no timestamped report exists
      writeFileSync(join(dir, 'result.json'), '{}')
      const dir2 = mkdtempSync(join(tmpdir(), 'nc-result-path2-'))
      try {
        writeFileSync(join(dir2, 'result.json'), '{}')
        expect(await resolveResultPath(dir2)).toBe(join(dir2, 'result.json'))
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
