import type { AddressInfo } from 'node:net'
import type {ControlRouterDeps} from '../http';
import type {
  KernelState,
  MihomoSupervisor,
  ProfileMeta,
  ProfileStore,
} from '../types'
import type { ExportRecord, NodeCheckClass,NodeCheckConfig, NodeCheckConfigStore } from './config'
import type { DetectionResult } from './detect'
import type { ClassifiedSlices } from './export'
import type { JobRequest, JobStatus } from './jobs'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toNodeListener } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {  createControlRouter } from '../http'
import {
  DEFAULT_NODE_CHECK_CONFIG
  
  
} from './config'

function config(overrides: Partial<NodeCheckConfig> = {}): NodeCheckConfig {
  return {
    ...structuredClone(DEFAULT_NODE_CHECK_CONFIG),
    ...overrides,
  }
}

function supervisorStub(): MihomoSupervisor {
  const state: KernelState = {
    status: 'stopped',
    externalController: '127.0.0.1:9090',
    secret: 'test',
  }
  return {
    getState: vi.fn(() => state),
    start: vi.fn(async () => state),
    stop: vi.fn(async () => state),
    restart: vi.fn(async () => state),
    setBinaryPath: vi.fn(),
    validate: vi.fn(async () => ({ valid: true, message: 'ok' })),
    on: vi.fn(),
    off: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
}

function profileStoreStub(metas: ProfileMeta[]): ProfileStore {
  return {
    list: vi.fn(async () => metas),
  } as unknown as ProfileStore
}

function detectionResult(): DetectionResult {
  return {
    nodes: [],
    classes: { ai: [], streaming: [], download: [] },
    yaml: {
      ai: 'proxies: []\n',
      streaming: 'proxies: []\n',
      download: 'proxies: []\n',
    },
  }
}

interface Harness {
  deps: ControlRouterDeps
  readConfig: ReturnType<typeof vi.fn>
  writeConfig: ReturnType<typeof vi.fn>
  acquire: ReturnType<typeof vi.fn>
  appliedResult: ReturnType<typeof vi.fn>
  startRequest: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  exportNodeSets: ReturnType<typeof vi.fn>
  setExports: (generation: number) => void
  close: () => Promise<void>
  base: string
}

async function harness(token?: string): Promise<Harness> {
  const homeDir = mkdtempSync(join(tmpdir(), 'mcxd-node-check-api-'))
  const stored = config({
    tags: { 'sub-1': 'free组' },
    refreshTransport: { 'sub-1': { mode: 'githubProxy', proxyId: 'gh-1' } },
  })
  const readConfig = vi.fn(async () => structuredClone(stored))
  const writeConfig = vi.fn(
    async (
      mutator: (value: NodeCheckConfig) => void | Promise<void>,
    ): Promise<NodeCheckConfig> => {
      const next = structuredClone(stored)
      await mutator(next)
      Object.assign(stored, next)
      return structuredClone(stored)
    },
  )
  const configStore = {
    path: join(homeDir, 'node-check-config.json'),
    readConfig,
    writeConfig,
  } satisfies NodeCheckConfigStore

  const profiles = profileStoreStub([
    {
      id: 'sub-1',
      name: 'sub one',
      type: 'remote',
      url: 'https://sub.example/one',
      updatedAt: 1,
    },
    {
      id: 'sub-2',
      name: 'sub two',
      type: 'remote',
      url: 'https://sub.example/two',
      updatedAt: 1,
    },
    { id: 'local-1', name: 'local', type: 'local', updatedAt: 1 },
  ])
  const acquire = vi.fn(async () => ({
    content:
      'proxies:\n  - name: node-1\n    type: direct\n    server: one.example\n',
    finalUrl: 'https://sub.example/one',
  }))
  const startRequest = vi.fn(async (_request: JobRequest) => 'job-1')
  const status: JobStatus = {
    id: 'job-1',
    state: 'completed',
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    subscriptionIds: ['sub-1'],
    resultId: 'result-1',
  }
  const start = vi.fn((value: JobRequest) => startRequest(value))
  const getStatus = vi.fn(async () => status)
  const appliedResult = vi.fn(async (resultId: string) => {
    if (resultId !== 'result-1')
      throw new Error(`Unexpected result ${resultId}`)
    return detectionResult()
  })
  const apply = vi.fn(async (resultId: string) => appliedResult(resultId))
  const setExports = (generation: number) => {
    for (const nodeClass of [
      'ai',
      'streaming',
      'download',
    ] as NodeCheckClass[]) {
      stored.exports[nodeClass] = {
        providerName: `nc-${nodeClass}`,
        filePath: `/data/node-sets/current/${nodeClass}.yaml`,
        generation,
      } satisfies ExportRecord
    }
  }
  const exportNodeSets = vi.fn(async () => {
    setExports(4)
    return { generation: 4, baseDir: '/data/node-sets' }
  })
  const baseDeps: ControlRouterDeps = {
    supervisor: supervisorStub(),
    profiles,
    info: vi.fn(),
    homeDir,
    activeConfigPath: join(homeDir, 'active.yaml'),
    token,
    nodeCheck: {
      configStore,
      acquire: acquire as never,
      jobManager: { start, getStatus, apply } as never,
      exportNodeSets: exportNodeSets as never,
    },
  }
  const app = createControlRouter(baseDeps)
  const server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  return {
    deps: baseDeps,
    readConfig,
    writeConfig,
    acquire,
    appliedResult,
    startRequest,
    start,
    getStatus,
    apply,
    exportNodeSets,
    setExports,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function jsonBody(body: unknown): {
  method: string
  headers: Record<string, string>
  body: string
} {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('createControlRouter — node-check API', () => {
  let srv: Harness | undefined
  afterEach(async () => {
    await srv?.close()
    srv = undefined
    vi.restoreAllMocks()
  })

  it('returns 404 for node-check routes when modules are not injected', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mcxd-node-check-api-'))
    const app = createControlRouter({
      supervisor: supervisorStub(),
      profiles: profileStoreStub([]),
      info: vi.fn(),
      homeDir,
      activeConfigPath: join(homeDir, 'active.yaml'),
    })
    const server = createServer(toNodeListener(app))
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const { port } = server.address() as AddressInfo
    try {
      const config = await fetch(
        `http://127.0.0.1:${port}/api/control/node-check/config`,
      )
      expect(config.status).toBe(404)
      expect(await config.json()).toEqual({ error: 'node-check unavailable' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('requires authentication for every node-check endpoint', async () => {
    srv = await harness('tok')
    const config = await fetch(`${srv.base}/api/control/node-check/config`)
    const put = await fetch(
      `${srv.base}/api/control/node-check/config`,
      jsonBody({ settings: {} }),
    )
    const detect = await fetch(
      `${srv.base}/api/control/node-check/detect`,
      jsonBody({ subscriptionIds: ['sub-1'] }),
    )
    const status = await fetch(
      `${srv.base}/api/control/node-check/status?job=job-1`,
    )
    const apply = await fetch(
      `${srv.base}/api/control/node-check/apply`,
      jsonBody({ jobId: 'job-1' }),
    )
    for (const response of [config, put, detect, status, apply]) {
      expect(response.status).toBe(401)
    }
    expect(srv.readConfig).not.toHaveBeenCalled()
    expect(srv.start).not.toHaveBeenCalled()
  })

  it('gET /node-check/config returns the config store value', async () => {
    srv = await harness()
    const response = await fetch(`${srv.base}/api/control/node-check/config`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      tags: { 'sub-1': 'free组' },
    })
    expect(srv.readConfig).toHaveBeenCalledOnce()
  })

  it('pUT /node-check/config merges a validated partial config', async () => {
    srv = await harness()
    const response = await fetch(`${srv.base}/api/control/node-check/config`, {
      ...jsonBody({
        tags: { 'sub-2': 'paid' },
        settings: { minSpeedBytes: 2048 },
      }),
      method: 'PUT',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      tags: { 'sub-1': 'free组', 'sub-2': 'paid' },
      settings: { minSpeedBytes: 2048 },
    })
    expect(srv.writeConfig).toHaveBeenCalledOnce()
  })

  it('pUT /node-check/config rejects invalid, oversized, and unknown partials', async () => {
    srv = await harness()
    const invalid = [
      [],
      { schemaVersion: -1 },
      { tags: { 'sub-1': 'x'.repeat(257) } },
      { settings: { minSpeedBytes: -1 } },
      { settings: { speedTiers: Array.from({length: 17}).fill(1) } },
      { exports: { ai: { providerName: 'nc-ai', filePath: '/x' } } },
      { unknown: true },
    ]
    for (const body of invalid) {
      const response = await fetch(
        `${srv.base}/api/control/node-check/config`,
        {
          ...jsonBody(body),
          method: 'PUT',
        },
      )
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400)
    }
    expect(srv.writeConfig).not.toHaveBeenCalled()
  })

  it('pOST /node-check/detect acquires each subscription and starts one job', async () => {
    srv = await harness()
    const response = await fetch(
      `${srv.base}/api/control/node-check/detect`,
      jsonBody({ subscriptionIds: ['sub-1', 'sub-2'] }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ jobId: 'job-1' })
    expect(srv.acquire).toHaveBeenCalledTimes(2)
    expect(srv.acquire).toHaveBeenNthCalledWith(1, 'https://sub.example/one', {
      mode: 'githubProxy',
      proxyId: 'gh-1',
    })
    expect(srv.acquire).toHaveBeenNthCalledWith(2, 'https://sub.example/two', {
      mode: 'direct',
    })
    const jobRequest = srv.startRequest.mock.calls[0]?.[0] as JobRequest
    expect(jobRequest.subscriptionIds).toEqual(['sub-1', 'sub-2'])
    expect(jobRequest.frozenYamlContent).toContain('__nc_1')
    expect(jobRequest.frozenYamlContent).toContain('__nc_2')
    expect(jobRequest.frozenYamlContent).not.toContain('name: node\n')
    expect(jobRequest.subscriptionByTempName).toEqual({
      __nc_1: 'sub-1',
      __nc_2: 'sub-2',
    })
  })

  it('pOST /node-check/detect rejects invalid subscription id lists', async () => {
    srv = await harness()
    const invalid = [
      {},
      { subscriptionIds: [] },
      { subscriptionIds: 'sub-1' },
      { subscriptionIds: Array.from({ length: 51 }, (_, i) => `sub-${i}`) },
      { subscriptionIds: ['sub-1', 'missing'] },
      { subscriptionIds: ['sub-1', 'local-1'] },
      { subscriptionIds: ['sub-1', 2] },
      { subscriptionIds: ['sub-1'], extra: true },
    ]
    for (const body of invalid) {
      const response = await fetch(
        `${srv.base}/api/control/node-check/detect`,
        jsonBody(body),
      )
      expect(response.status, JSON.stringify(body).slice(0, 100)).toBe(400)
    }
    expect(srv.acquire).not.toHaveBeenCalled()
    expect(srv.start).not.toHaveBeenCalled()
  })

  it('pOST /node-check/detect returns 502 when acquisition fails', async () => {
    srv = await harness()
    srv.acquire.mockRejectedValueOnce(new Error('upstream unavailable'))
    const response = await fetch(
      `${srv.base}/api/control/node-check/detect`,
      jsonBody({ subscriptionIds: ['sub-1'] }),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: 'subscription acquisition failed',
    })
    expect(srv.start).not.toHaveBeenCalled()
  })

  it('gET /node-check/status forwards the job id to the job manager', async () => {
    srv = await harness()
    const response = await fetch(
      `${srv.base}/api/control/node-check/status?job=job-1`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: 'job-1',
      state: 'completed',
    })
    expect(srv.getStatus).toHaveBeenCalledWith('job-1')
  })

  it('gET /node-check/status validates the job query', async () => {
    srv = await harness()
    expect(
      (await fetch(`${srv.base}/api/control/node-check/status`)).status,
    ).toBe(400)
    expect(
      (
        await fetch(
          `${srv.base}/api/control/node-check/status?job=${'x'.repeat(129)}`,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(
          `${srv.base}/api/control/node-check/status?job=../etc%2Fpasswd`,
        )
      ).status,
    ).toBe(400)
    expect(srv.getStatus).not.toHaveBeenCalled()
  })

  it('pOST /node-check/apply uses the job result id, exports provider info, and is repeatable', async () => {
    srv = await harness()
    const slice: ClassifiedSlices = {
      'sub-1': {
        __nc_1: {
          class: 'ai',
          renamedNode: { name: 'free组_美国_AI_1', type: 'direct' },
        },
      },
    }
    const result = detectionResult()
    result.subscriptionIds = ['sub-1']
    result.subscriptionByTempName = { __nc_1: 'sub-1' }
    result.nodes = [
      {
        index: 1,
        name: '__nc_1',
        error: '',
        latency: {},
        speed: {},
        media: [],
        ai: [],
        class: 'ai',
        aliveness: 'alive',
        proxy: slice['sub-1']!.__nc_1!.renamedNode,
        renamed: 'free组_美国_AI_1',
      },
    ]
    result.classes.ai = result.nodes
    let applyCalls = 0
    const active = srv
    active.appliedResult.mockResolvedValue(result)
    active.exportNodeSets.mockImplementation(async () => {
      applyCalls += 1
      active.setExports(4)
      return { generation: 4, baseDir: '/data/node-sets' }
    })

    const first = await fetch(
      `${srv.base}/api/control/node-check/apply`,
      jsonBody({ jobId: 'job-1' }),
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      generation: 4,
      providers: {
        ai: {
          providerName: 'nc-ai',
          filePath: '/data/node-sets/current/ai.yaml',
          generation: 4,
        },
        streaming: {
          providerName: 'nc-streaming',
          filePath: '/data/node-sets/current/streaming.yaml',
          generation: 4,
        },
        download: {
          providerName: 'nc-download',
          filePath: '/data/node-sets/current/download.yaml',
          generation: 4,
        },
      },
    })
    expect(active.apply).toHaveBeenCalledWith('job-1')
    expect(active.exportNodeSets).toHaveBeenCalledWith(
      expect.any(Object),
      slice,
    )
    expect(applyCalls).toBe(1)
  })

  it('pOST /node-check/apply validates the job id and maps failures to clean errors', async () => {
    srv = await harness()
    for (const body of [
      {},
      { jobId: '' },
      { jobId: 'x'.repeat(129) },
      { jobId: '../result' },
      { jobId: 1 },
      { jobId: 'job-1', extra: true },
    ]) {
      const response = await fetch(
        `${srv.base}/api/control/node-check/apply`,
        jsonBody(body),
      )
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect(srv.apply).not.toHaveBeenCalled()

    srv.apply.mockRejectedValueOnce(new Error('job is still running'))
    const failed = await fetch(
      `${srv.base}/api/control/node-check/apply`,
      jsonBody({ jobId: 'job-1' }),
    )
    expect(failed.status).toBe(409)
    expect(await failed.json()).toEqual({
      error: 'job is still running',
    })
  })
})
