import type { NodeCheckConfig, NodeCheckJobStatus } from '~/types/control'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decorateResultNodes,
  filterResultNodes,
  firstEnabledGithubProxy,
  joinGithubProxyPrefix,
  parseSubscriptionEntries,
  useNodeCheck,
} from '../useNodeCheck'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast }))

const api = {
  getNodeCheckConfig: vi.fn(),
  updateNodeCheckConfig: vi.fn(),
  importProfile: vi.fn(),
  updateProfile: vi.fn(),
  startNodeCheckDetect: vi.fn(),
  getNodeCheckStatus: vi.fn(),
  getNodeCheckResult: vi.fn(),
  applyNodeCheck: vi.fn(),
}
vi.mock('../useControlApi', () => ({ useControlApi: () => api }))

const config = (): NodeCheckConfig => ({
  schemaVersion: 1,
  tags: {},
  refreshTransport: {},
  githubProxies: [
    { id: 'gh-1', prefix: 'https://gh-proxy.org/', enabled: true },
    { id: 'gh-2', prefix: 'https://disabled.example/', enabled: false },
  ],
  settings: { minSpeedBytes: 1_048_576, speedTiers: [], regionNames: {} },
  exports: {},
  jobs: { completed: [] },
  remoteProfiles: [
    {
      id: 'sub-1',
      name: 'Sub One',
      type: 'remote',
      url: 'https://example.com/sub',
      updatedAt: 1,
    },
  ],
})

const completedJob = (): NodeCheckJobStatus => ({
  id: 'job-1',
  state: 'completed',
  progress: 100,
  createdAt: 1,
  updatedAt: 2,
  subscriptionIds: ['sub-1'],
  resultId: 'job-1',
})

const detectionResult = () => ({
  nodes: [
    {
      index: 1,
      name: '__nc_1',
      class: 'ai' as const,
      aliveness: 'alive' as const,
      latency: {},
      speed: { avg: 2_097_152 },
      ai: [{ platform: 'OpenAI', status: 'unlock' }],
      media: [],
      outbound: { country: 'United States' },
    },
    {
      index: 2,
      name: '__nc_2',
      class: 'discard' as const,
      aliveness: 'dead' as const,
      latency: {},
      speed: {},
      ai: [],
      media: [],
    },
  ],
})

describe('composables/useNodeCheck helpers', () => {
  it('parses multiline URL + optional name entries and flags invalid URLs', () => {
    expect(
      parseSubscriptionEntries(
        '# comment\nhttps://a.example/sub alpha\nhttps://b.example/sub\nnope\n',
      ),
    ).toEqual([
      { url: 'https://a.example/sub', name: 'alpha' },
      { url: 'https://b.example/sub' },
      { url: 'nope', invalid: true },
    ])
  })

  it('formats bytes/sec as MiB/s and filters by class and text', () => {
    const nodes = decorateResultNodes(detectionResult().nodes as never)
    expect(nodes[0]?.speedMBs).toBe(2)
    expect(nodes[0]?.region).toBe('United States')
    expect(filterResultNodes(nodes, 'ai', '')).toHaveLength(1)
    expect(filterResultNodes(nodes, 'all', 'unlock')).toHaveLength(1)
    expect(filterResultNodes(nodes, 'download', '')).toHaveLength(0)
  })

  it('joins GitHub proxy prefixes and selects only enabled proxies', () => {
    expect(
      joinGithubProxyPrefix('https://gh-proxy.org/', 'https://a/sub'),
    ).toBe('https://gh-proxy.org/https://a/sub')
    expect(firstEnabledGithubProxy(config().githubProxies)?.id).toBe('gh-1')
  })
})

describe('composables/useNodeCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getNodeCheckConfig.mockResolvedValue(config())
    api.updateNodeCheckConfig.mockImplementation(async (patch) => ({
      ...config(),
      ...patch,
    }))
    api.importProfile.mockResolvedValue({ id: 'imported' })
    api.updateProfile.mockResolvedValue({ id: 'imported' })
  })

  it('loads remote profiles from the config response', async () => {
    const check = useNodeCheck()
    await check.load()
    expect(check.remoteProfiles.value.map((profile) => profile.id)).toEqual([
      'sub-1',
    ])
  })

  it('imports GitHub-proxy entries through the proxy but stores the source URL', async () => {
    const check = useNodeCheck()
    await check.load()
    check.bulkText.value = 'https://example.com/new free'
    check.bulkTransport.value = 'githubProxy'
    await check.addSubscriptions()
    expect(api.importProfile).toHaveBeenCalledWith(
      'https://gh-proxy.org/https://example.com/new',
      'free',
    )
    expect(api.updateProfile).toHaveBeenCalledWith('imported', {
      url: 'https://example.com/new',
    })
  })

  it('polls detection status, loads the result, and exports provider records', async () => {
    api.startNodeCheckDetect.mockResolvedValue({ jobId: 'job-1' })
    api.getNodeCheckStatus.mockResolvedValue(completedJob())
    api.getNodeCheckResult.mockResolvedValue(detectionResult())
    api.applyNodeCheck.mockResolvedValue({
      generation: 4,
      providers: {
        ai: {
          providerName: 'nc-ai',
          filePath: '/data/node-sets/current/ai.yaml',
          generation: 4,
        },
      },
    })

    const check = useNodeCheck()
    await check.load()
    check.selectedSubscriptionIds.value = ['sub-1']
    await check.startDetection()
    expect(api.getNodeCheckResult).toHaveBeenCalledWith('job-1')
    expect(check.resultNodes.value).toHaveLength(2)

    await check.apply()
    expect(api.applyNodeCheck).toHaveBeenCalledWith('job-1')
    expect(check.resultProviderSnippet.value).toContain('type: file')
    expect(check.resultProviderSnippet.value).toContain(
      '/data/node-sets/current/ai.yaml',
    )
  })
})
