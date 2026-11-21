import type { ComputedRef } from 'vue'
import type {
  NodeCheckClass,
  NodeCheckConfig,
  NodeCheckConfigPatch,
  NodeCheckDetectionResult,
  NodeCheckDetectResponse,
  NodeCheckGithubProxy,
  NodeCheckJobStatus,
  NodeCheckRefreshTransport,
  NodeCheckResultClass,
  NodeCheckResultNode,
  ProfileMeta,
} from '~/types/control'
import { computed, onUnmounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { controlErrorMessage } from '~/utils/controlError'
import { useControlApi } from './useControlApi'

declare function useI18n(): { t: (key: string, named?: object) => string }

export const NODE_CHECK_CLASSES: NodeCheckClass[] = [
  'ai',
  'streaming',
  'download',
]
export const NODE_CHECK_RESULT_CLASSES: NodeCheckResultClass[] = [
  'ai',
  'streaming',
  'download',
  'discard',
]
export const NODE_CHECK_TRANSPORT_MODES = [
  'direct',
  'generalProxy',
  'githubProxy',
] as const

const POLL_INTERVAL_MS = 1500
const FINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled'])

export interface ParsedSubscriptionEntry {
  url: string
  name?: string
  invalid?: boolean
}

export function parseSubscriptionEntries(
  text: string,
): ParsedSubscriptionEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const separator = /\s+/u.exec(line)
      const rawUrl = separator ? line.slice(0, separator.index) : line
      const name = separator ? line.slice(separator.index + 1).trim() : ''
      const url = rawUrl
      let invalid = false
      try {
        const parsed = new URL(url)
        invalid = parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
      } catch {
        invalid = true
      }
      return {
        url,
        ...(name ? { name } : {}),
        ...(invalid ? { invalid: true as const } : {}),
      }
    })
}

export function formatSpeedMBs(bytesPerSecond?: number): number | undefined {
  if (
    typeof bytesPerSecond !== 'number' ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond < 0
  ) {
    return undefined
  }
  return bytesPerSecond / 1024 / 1024
}

function capabilityStatus(
  node: NodeCheckResultNode,
  platform: string,
): string | undefined {
  const matches = [...node.ai, ...node.media].filter(
    (entry) =>
      entry.platform.toLowerCase() === platform ||
      entry.platform.toLowerCase().includes(platform),
  )
  const status = matches.find((entry) => entry.status === 'unlock')?.status
  return status ?? matches[0]?.status
}

function landingRegion(node: NodeCheckResultNode): string | undefined {
  const fields = [node.outbound?.country, node.outbound?.region]
  return fields.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
}

export function decorateResultNodes(
  nodes: NodeCheckResultNode[],
): NodeCheckResultNode[] {
  return nodes.map((node) => ({
    ...node,
    speedMBs: formatSpeedMBs(node.speed?.avg),
    region: landingRegion(node),
  }))
}

export function resultSearchText(node: NodeCheckResultNode): string {
  return [
    node.class,
    node.name,
    node.renamed ?? '',
    node.subscriptionId ?? '',
    node.aliveness,
    capabilityStatus(node, 'openai') ?? '',
    capabilityStatus(node, 'youtube') ?? '',
    node.region ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

export function filterResultNodes(
  nodes: NodeCheckResultNode[],
  classFilter: NodeCheckResultClass | 'all',
  query = '',
): NodeCheckResultNode[] {
  const needle = query.trim().toLowerCase()
  return nodes.filter(
    (node) =>
      (classFilter === 'all' || node.class === classFilter) &&
      (!needle || resultSearchText(node).includes(needle)),
  )
}

export function githubProxyOptionLabel(
  proxy: NodeCheckGithubProxy | undefined,
): string {
  if (!proxy) return ''
  return proxy.prefix.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export function joinGithubProxyPrefix(prefix: string, url: string): string {
  return `${prefix.replace(/\/+$/, '')}/${url}`
}

export function firstEnabledGithubProxy(
  proxies: NodeCheckGithubProxy[],
): NodeCheckGithubProxy | undefined {
  return proxies.find((proxy) => proxy.enabled)
}

export function createGithubProxyId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `gh-${uuid.replace(/[^\w.-]/g, '-')}`
}

export function useNodeCheck() {
  const api = useControlApi()
  const { t } = useI18n()

  const config = ref<NodeCheckConfig | null>(null)
  const configLoading = ref(false)
  const configSaving = ref(false)
  const importing = ref(false)
  const starting = ref(false)
  const applying = ref(false)
  const job = ref<NodeCheckJobStatus | null>(null)
  const result = ref<NodeCheckDetectionResult | null>(null)
  const applyResult = ref<Awaited<
    ReturnType<typeof api.applyNodeCheck>
  > | null>(null)
  const bulkText = ref('')
  const bulkTransport = ref<'direct' | 'githubProxy'>('direct')
  const selectedSubscriptionIds = ref<string[]>([])
  const classFilter = ref<NodeCheckResultClass | 'all'>('all')
  const resultQuery = ref('')
  const bulkErrors = ref<string[]>([])

  let pollTimer: ReturnType<typeof setTimeout> | undefined

  const remoteProfiles = computed(
    () => config.value?.remoteProfiles ?? [],
  ) as ComputedRef<ProfileMeta[]>

  const enabledGithubProxies = computed(() =>
    (config.value?.githubProxies ?? []).filter((proxy) => proxy.enabled),
  )

  const progress = computed(() => job.value?.progress ?? 0)
  const running = computed(
    () => job.value?.state === 'pending' || job.value?.state === 'running',
  )

  const resultNodes = computed(() =>
    decorateResultNodes(result.value?.nodes ?? []),
  )

  const filteredNodes = computed(() =>
    filterResultNodes(resultNodes.value, classFilter.value, resultQuery.value),
  )

  const resultCounts = computed(() => ({
    all: resultNodes.value.length,
    ai: resultNodes.value.filter((node) => node.class === 'ai').length,
    streaming: resultNodes.value.filter((node) => node.class === 'streaming')
      .length,
    download: resultNodes.value.filter((node) => node.class === 'download')
      .length,
    discard: resultNodes.value.filter((node) => node.class === 'discard')
      .length,
  }))

  const notifyError = (error: unknown, key: string) => {
    toast.error(t(key), { description: controlErrorMessage(error) })
  }

  const load = async () => {
    configLoading.value = true
    try {
      const loaded = await api.getNodeCheckConfig()
      config.value = loaded
      const available = new Set(
        (loaded.remoteProfiles ?? []).map((profile) => profile.id),
      )
      selectedSubscriptionIds.value = selectedSubscriptionIds.value.filter(
        (id) => available.has(id),
      )
    } catch (error) {
      notifyError(error, 'nodeCheckLoadFailed')
    } finally {
      configLoading.value = false
    }
  }

  const saveConfig = async (patch: NodeCheckConfigPatch) => {
    configSaving.value = true
    try {
      config.value = await api.updateNodeCheckConfig(patch)
      return true
    } catch (error) {
      notifyError(error, 'nodeCheckSaveFailed')
      return false
    } finally {
      configSaving.value = false
    }
  }

  const setTag = async (id: string, tag: string) => {
    if (!config.value) return false
    return saveConfig({ tags: { ...config.value.tags, [id]: tag } })
  }

  const setTransport = async (
    id: string,
    transport: NodeCheckRefreshTransport,
  ) => {
    if (!config.value) return false
    return saveConfig({
      refreshTransport: {
        ...config.value.refreshTransport,
        [id]: transport,
      },
    })
  }

  const setGithubProxies = async (proxies: NodeCheckGithubProxy[]) =>
    saveConfig({ githubProxies: proxies })

  const updateGithubProxy = async (
    id: string,
    patch: Partial<NodeCheckGithubProxy>,
  ) => {
    if (!config.value) return false
    const proxies = config.value.githubProxies.map((proxy) =>
      proxy.id === id ? { ...proxy, ...patch } : proxy,
    )
    return setGithubProxies(proxies)
  }

  const addGithubProxy = async () => {
    if (!config.value) return false
    return setGithubProxies([
      ...config.value.githubProxies,
      { id: createGithubProxyId(), prefix: '', enabled: true },
    ])
  }

  const removeGithubProxy = async (id: string) => {
    if (!config.value) return false
    return setGithubProxies(
      config.value.githubProxies.filter((proxy) => proxy.id !== id),
    )
  }

  const addSubscriptions = async () => {
    const entries = parseSubscriptionEntries(bulkText.value)
    const invalid = entries.filter((entry) => entry.invalid)
    if (invalid.length > 0) {
      bulkErrors.value = invalid.map((entry) => entry.url)
      toast.error(t('nodeCheckBulkInvalid'))
      return
    }
    if (entries.length === 0) return

    importing.value = true
    bulkErrors.value = []
    try {
      const proxies = enabledGithubProxies.value
      for (const entry of entries) {
        try {
          const githubProxy = firstEnabledGithubProxy(proxies)
          const fetchUrl =
            bulkTransport.value === 'githubProxy'
              ? rewriteBulkImportUrl(entry.url, githubProxy)
              : entry.url
          const imported = await api.importProfile(fetchUrl, entry.name)
          if (bulkTransport.value === 'githubProxy') {
            await api.updateProfile(imported.id, { url: entry.url })
          }
        } catch (error) {
          bulkErrors.value.push(entry.url)
          notifyError(error, 'nodeCheckBulkImportFailed')
        }
      }
      bulkText.value = ''
      await load()
      if (bulkErrors.value.length === 0)
        toast.success(t('nodeCheckBulkImported'))
    } finally {
      importing.value = false
    }
  }

  const rewriteBulkImportUrl = (
    url: string,
    proxy: NodeCheckGithubProxy | undefined,
  ) => {
    if (!proxy) throw new Error(t('nodeCheckGithubProxyRequired'))
    return joinGithubProxyPrefix(proxy.prefix, url)
  }
  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
  }

  const pollStatus = async (jobId: string) => {
    try {
      const status = await api.getNodeCheckStatus(jobId)
      job.value = status
      if (status.error) {
        toast.error(t('nodeCheckDetectFailed'), {
          description: controlErrorMessage(status.error),
        })
      }
      if (FINAL_JOB_STATES.has(status.state)) {
        await load()
        if (status.state === 'completed') {
          try {
            result.value = await api.getNodeCheckResult(jobId)
          } catch (error) {
            notifyError(error, 'nodeCheckResultFailed')
          }
          toast.success(t('nodeCheckCompleted'))
        }
        return
      }
    } catch (error) {
      stopPolling()
      notifyError(error, 'nodeCheckStatusFailed')
      return
    }
    pollTimer = setTimeout(() => void pollStatus(jobId), POLL_INTERVAL_MS)
  }

  const startDetection = async () => {
    if (selectedSubscriptionIds.value.length === 0 || running.value) return
    starting.value = true
    stopPolling()
    try {
      const response: NodeCheckDetectResponse = await api.startNodeCheckDetect(
        selectedSubscriptionIds.value,
      )
      result.value = null
      applyResult.value = null
      job.value = {
        id: response.jobId,
        state: 'pending',
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        subscriptionIds: [...selectedSubscriptionIds.value],
      }
      await pollStatus(response.jobId)
    } catch (error) {
      notifyError(error, 'nodeCheckDetectFailed')
    } finally {
      starting.value = false
    }
  }

  const apply = async () => {
    const id = job.value?.resultId ?? job.value?.id
    if (!id || job.value?.state !== 'completed') return
    applying.value = true
    try {
      applyResult.value = await api.applyNodeCheck(id)
      await load()
      toast.success(t('nodeCheckApplied'))
    } catch (error) {
      notifyError(error, 'nodeCheckApplyFailed')
    } finally {
      applying.value = false
    }
  }

  const resultProviderSnippet = computed(() => {
    const providers = applyResult.value?.providers ?? {}
    return NODE_CHECK_CLASSES.map((nodeClass) => {
      const record = providers[nodeClass]
      if (!record) return ''
      return `  ${record.providerName}:\n    type: file\n    path: ${record.filePath}`
    })
      .filter(Boolean)
      .join('\n')
  })

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t('nodeCheckCopied'))
    } catch {
      toast.error(t('nodeCheckCopyFailed'))
    }
  }

  onUnmounted(stopPolling)

  return {
    config,
    configLoading,
    configSaving,
    importing,
    starting,
    applying,
    job,
    result,
    applyResult,
    bulkText,
    bulkTransport,
    bulkErrors,
    selectedSubscriptionIds,
    classFilter,
    resultQuery,
    remoteProfiles,
    enabledGithubProxies,
    progress,
    running,
    resultNodes,
    filteredNodes,
    resultCounts,
    resultProviderSnippet,
    load,
    saveConfig,
    setTag,
    setTransport,
    addGithubProxy,
    updateGithubProxy,
    removeGithubProxy,
    addSubscriptions,
    startDetection,
    apply,
    copyText,
  }
}
