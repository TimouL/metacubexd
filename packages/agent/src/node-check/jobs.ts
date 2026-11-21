import type { NodeCheckConfig, NodeCheckConfigStore } from './config'
import type { DetectionOptions, DetectionResult } from './detect'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_NODE_CHECK_CONFIG } from './config'

const CONFIG_KEYS = [
  'schemaVersion',
  'tags',
  'refreshTransport',
  'githubProxies',
  'generalProxy',
  'settings',
  'exports',
] as const

const defaults: Record<string, number> = {
  defaultTimeoutMs: 15 * 60 * 1000,
  maxCompletedJobs: 20,
  maxResults: 20,
  resultTtlMs: 24 * 60 * 60 * 1000,
}

export function getNodeCheckJobsPath(dir: string): string {
  return join(dir, 'node-check-jobs.json')
}

export function fingerprintConfig(config: NodeCheckConfig): string {
  const value: Record<string, unknown> = {}
  for (const key of CONFIG_KEYS) value[key] = config[key]
  return stableStringify(value)
}

export interface JobManagerOptions {
  dir?: string
  path?: string
  detect?: (
    frozenYamlContent: string,
    opts?: DetectionOptions,
  ) => Promise<DetectionResult>
  apply?: (
    resultId: string,
    request: JobRequest,
  ) => ApplyResult | Promise<ApplyResult>
  loadConfig?: () => Promise<NodeCheckConfig>
  loadProxies?: () => Promise<unknown[]>
  buildFrozenYaml?: (proxies: unknown[]) => string | Promise<string>
  configStore?: NodeCheckConfigStore
  defaultTimeoutMs?: number
  maxCompletedJobs?: number
  maxResults?: number
  resultTtlMs?: number
  clock?: () => number
  advanceTime?: (ms: number) => void
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  idFactory?: () => string
}

export interface JobRequest {
  frozenYamlContent?: string
  subscriptionByTempName?: Record<string, string>
  subscriptionIds: string[]
  fingerprint?: string
  tag?: string
  timeoutMs?: number
  detection?: Omit<DetectionOptions, 'signal' | 'log'>
  metadata?: Record<string, unknown>
}

export const JOB_STATES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const

export type JobState = (typeof JOB_STATES)[number]

export interface JobStatus {
  id: string
  state: JobState
  progress: number
  createdAt: number
  updatedAt: number
  subscriptionIds: string[]
  resultId?: string
  error?: string
  expired?: boolean
}

export interface JobDetail extends JobStatus {
  result?: DetectionResult
}

export interface StoredResult {
  request: NormalizedRequest
  result: DetectionResult
  subscriptionByTempName?: Record<string, string>
  createdAt: number
}

export interface StoredJob extends JobStatus {
  fingerprint?: string
  fingerprintSource?: 'request' | 'config' | 'persisted'
}

export interface ApplyResult {
  generation?: number
  [key: string]: unknown
}

export type DetectFn = (
  frozenYamlContent: string,
  opts?: DetectionOptions,
) => Promise<DetectionResult>

export type ApplyFn = (
  resultId: string,
  request: NormalizedRequest,
) => Promise<ApplyResult> | ApplyResult

export interface NormalizedRequest {
  frozenYamlContent?: string
  subscriptionByTempName?: Record<string, string>
  subscriptionIds: string[]
  fingerprint?: string
  tag?: string
  timeoutMs?: number
  detection?: Omit<DetectionOptions, 'signal' | 'log'>
  metadata?: Record<string, unknown>
}

interface PersistedState {
  jobs: StoredJob[]
  results: Record<string, StoredResult>
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && item !== '',
  )
}

function cleanStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined
    result[key] = entry
  }
  return result
}

function clampProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function normalizeRequest(value: unknown): NormalizedRequest | undefined {
  if (!isPlainObject(value)) return undefined
  const frozenYamlContent = value.frozenYamlContent
  const subscriptionByTempName = cleanStringRecord(value.subscriptionByTempName)
  return {
    ...(typeof frozenYamlContent === 'string' ? { frozenYamlContent } : {}),
    ...(subscriptionByTempName ? { subscriptionByTempName } : {}),
    subscriptionIds: cleanStringArray(value.subscriptionIds),
    ...(cleanString(value.fingerprint)
      ? { fingerprint: cleanString(value.fingerprint) }
      : {}),
    ...(cleanString(value.tag) ? { tag: cleanString(value.tag) } : {}),
    ...(typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
      ? { timeoutMs: value.timeoutMs }
      : {}),
    ...(isPlainObject(value.detection)
      ? { detection: value.detection as NormalizedRequest['detection'] }
      : {}),
    ...(isPlainObject(value.metadata) ? { metadata: value.metadata } : {}),
  }
}

function normalizeJob(value: unknown): StoredJob | undefined {
  if (!isPlainObject(value)) return undefined
  const id = cleanString(value.id)
  const state = value.state
  if (!id || !JOB_STATES.includes(state as never)) return undefined
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0
  const updatedAt =
    typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : createdAt
  const job: StoredJob = {
    id,
    state: state as JobState,
    progress: clampProgress(value.progress),
    createdAt,
    updatedAt,
    subscriptionIds: cleanStringArray(value.subscriptionIds),
  }
  const resultId = cleanString(value.resultId)
  if (resultId) job.resultId = resultId
  const error = cleanString(value.error)
  if (error) job.error = error
  const fingerprint = cleanString(value.fingerprint)
  if (fingerprint) job.fingerprint = fingerprint
  if (
    value.fingerprintSource === 'request' ||
    value.fingerprintSource === 'config' ||
    value.fingerprintSource === 'persisted'
  ) {
    job.fingerprintSource = value.fingerprintSource
  }
  if (value.expired === true) job.expired = true
  return job
}

function normalizeResult(value: unknown): StoredResult | undefined {
  if (!isPlainObject(value)) return undefined
  const request = normalizeRequest(value.request)
  if (
    !request ||
    !isPlainObject(value.result) ||
    !Array.isArray(value.result.nodes)
  ) {
    return undefined
  }
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0
  return {
    request,
    result: value.result as unknown as DetectionResult,
    ...(request.subscriptionByTempName
      ? { subscriptionByTempName: request.subscriptionByTempName }
      : {}),
    createdAt,
  }
}

function normalizePersisted(value: unknown): PersistedState {
  if (!isPlainObject(value)) return { jobs: [], results: {} }
  const jobs = Array.isArray(value.jobs)
    ? value.jobs
        .map(normalizeJob)
        .filter((job): job is StoredJob => job !== undefined)
    : []
  const results: Record<string, StoredResult> = {}
  if (isPlainObject(value.results)) {
    for (const [id, raw] of Object.entries(value.results)) {
      const result = normalizeResult(raw)
      if (result) results[id] = result
    }
  }
  return { jobs, results }
}

function publicStatus(job: StoredJob): JobStatus {
  const {
    fingerprint: _fingerprint,
    fingerprintSource: _fingerprintSource,
    ...status
  } = job
  return status
}

export function normalizeJobStatus(value: unknown): JobStatus | undefined {
  if (!isPlainObject(value)) {
    return typeof value === 'string'
      ? expiredStatus(value, 'Job not found')
      : undefined
  }
  const job = normalizeJob(value)
  if (job) return publicStatus(job)
  const id = cleanString(value.id)
  return id
    ? expiredStatus(id, cleanString(value.error) ?? 'Job not found')
    : undefined
}

function expiredStatus(id: string, message: string): JobStatus {
  return {
    id,
    state: 'failed',
    progress: 0,
    createdAt: 0,
    updatedAt: 0,
    subscriptionIds: [],
    error: message,
    expired: true,
  }
}

function defaultDetect(
  frozenYamlContent: string,
  detectOptions: DetectionOptions = {},
): Promise<DetectionResult> {
  return Promise.reject(
    new Error(
      `No detection function configured for job (${frozenYamlContent.length} bytes, timeout ${detectOptions.timeoutMs ?? 'default'})`,
    ),
  )
}

export { createJobManager }

function createJobManager(opts: JobManagerOptions) {
  const path =
    opts.path ??
    getNodeCheckJobsPath(opts.dir ?? process.env.DATA_DIR ?? '/data')
  const now = opts.now ?? opts.clock ?? Date.now
  const schedule = opts.setTimeout ?? setTimeout
  const unschedule = opts.clearTimeout ?? clearTimeout
  const detect = opts.detect ?? defaultDetect
  const newId = opts.idFactory ?? (() => randomUUID())
  const maxCompletedJobs = opts.maxCompletedJobs ?? defaults.maxCompletedJobs
  const resultTtlMs = Number.POSITIVE_INFINITY
  const loadConfig =
    opts.loadConfig ??
    (async () =>
      opts.configStore
        ? opts.configStore.readConfig()
        : structuredClone(DEFAULT_NODE_CHECK_CONFIG))

  const jobs = new Map<string, StoredJob>()
  const results = new Map<string, StoredResult>()
  const applied = new Set<string>()
  const applyResults = new Map<string, ApplyResult | undefined>()
  const expiredErrors = new Map<string, string>()
  const controllers = new Map<string, AbortController>()
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  let activeId: string | undefined
  let loadingState: Promise<void> | undefined
  let persistence: Promise<void> = Promise.resolve()
  let shuttingDown = false

  function updateJob(id: string, patch: Partial<StoredJob>): StoredJob {
    const existing = jobs.get(id)
    if (!existing) throw new Error(`Job ${id} not found`)
    const updated: StoredJob = { ...existing, ...patch, updatedAt: now() }
    jobs.set(id, updated)
    return updated
  }

  function ensureLoaded(): Promise<void> {
    if (!loadingState) {
      loadingState = (async () => {
        try {
          const raw = await readFile(path, 'utf8')
          const state = normalizePersisted(JSON.parse(raw) as unknown)
          for (const job of state.jobs) {
            if (
              job.state === 'pending' ||
              job.state === 'running' ||
              job.expired
            ) {
              continue
            }
            jobs.set(job.id, {
              ...job,
              fingerprintSource: 'persisted',
            })
          }
          for (const [id, entry] of Object.entries(state.results)) {
            const storedJob = jobs.get(id)
            if (!storedJob) continue
            results.set(id, entry)
          }
          for (const [id] of [...jobs]) {
            if (!results.has(id)) {
              jobs.delete(id)
              applied.add(id)
            }
          }
        } catch {
          jobs.clear()
          results.clear()
        }
      })()
    }
    return loadingState
  }

  function persist(): Promise<void> {
    const snapshot: PersistedState = {
      jobs: [...jobs.values()],
      results: Object.fromEntries(results),
    }
    const promise = persistence.then(async () => {
      await mkdir(join(path, '..'), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    persistence = promise.catch(() => {})
    return promise
  }

  function forget(id: string): void {
    jobs.delete(id)
    results.delete(id)
    applied.add(id)
  }

  function enforceRetention(force = false): void {
    let removed = false
    const overdue =
      false && force && resultTtlMs > 0
        ? [...results.entries()]
            .filter(([, entry]) => now() - entry.createdAt >= resultTtlMs)
            .map(([id]) => id)
        : []
    for (const id of overdue) {
      expiredErrors.set(id, 'Job expired')
      forget(id)
      removed = true
    }
    const eligible = [...jobs.values()]
      .filter((job) => job.state === 'completed')
      .sort((left, right) => left.createdAt - right.createdAt)
    for (const job of eligible.slice(maxCompletedJobs)) {
      expiredErrors.set(job.id, 'Job expired')
      forget(job.id)
      removed = true
    }
    for (const [id, entry] of [...results]) {
      if (
        !jobs.has(id) ||
        (resultTtlMs > 0 && now() - entry.createdAt >= resultTtlMs)
      ) {
        expiredErrors.set(id, 'Job expired')
        results.delete(id)
        applied.add(id)
        removed = true
      }
    }
    if (removed) void persist()
  }

  function clearDeadline(id: string): void {
    const handle = deadlines.get(id)
    if (handle) unschedule(handle)
    deadlines.delete(id)
  }

  function finish(
    id: string,
    patch: Partial<StoredJob>,
    storeResult?: StoredResult,
  ): void {
    clearDeadline(id)
    controllers.delete(id)
    if (activeId === id) activeId = undefined
    const finished = updateJob(id, patch)
    if (!finished.resultId) finished.resultId = finished.id
    if (storeResult) results.set(id, storeResult)
    enforceRetention()
    void persist()
  }

  async function runJob(
    id: string,
    request: NormalizedRequest,
    controller: AbortController,
  ): Promise<void> {
    updateJob(id, { state: 'running', progress: 10 })
    void persist()

    const timeout: number =
      request.timeoutMs ?? opts.defaultTimeoutMs ?? defaults.defaultTimeoutMs!
    if (timeout >= 0) {
      const handle = schedule(() => {
        controller.abort()
        finish(id, {
          state: 'failed',
          progress: 100,
          error: `Detection timed out after ${timeout}ms`,
        })
      }, timeout)
      deadlines.set(id, handle)
    }

    try {
      const result = await detect(request.frozenYamlContent ?? '', {
        ...request.detection,
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        finish(id, {
          state: 'cancelled',
          progress: 100,
          ...(shuttingDown ? { error: 'shutdown' } : {}),
        })
        return
      }
      finish(
        id,
        { state: 'completed', progress: 100, resultId: id },
        { request, result, createdAt: now() },
      )
    } catch (error) {
      if (controller.signal.aborted) {
        finish(id, {
          state: 'cancelled',
          progress: 100,
          ...(shuttingDown ? { error: 'shutdown' } : {}),
        })
        return
      }
      finish(id, {
        state: 'failed',
        progress: 100,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function prepareRequest(
    rawRequest: JobRequest,
  ): Promise<NormalizedRequest | undefined> {
    const request = normalizeRequest(rawRequest)
    if (!request) return undefined
    if (request.frozenYamlContent) return request
    const proxies = await opts.loadProxies?.()
    if (!proxies) return undefined
    let frozenYamlContent: string
    if (opts.buildFrozenYaml) {
      frozenYamlContent = await opts.buildFrozenYaml(proxies)
    } else {
      const { buildFrozenInput } = await import('./detect')
      frozenYamlContent = buildFrozenInput(proxies).content
    }
    return { ...request, frozenYamlContent }
  }

  return {
    async start(rawRequest: JobRequest): Promise<string> {
      await ensureLoaded()
      const request = await prepareRequest(rawRequest)
      if (!request) throw new Error('Invalid job request')
      if (shuttingDown) throw new Error('Job manager is shut down')
      if (activeId) {
        const active = jobs.get(activeId)
        if (
          active &&
          JSON.stringify(active.subscriptionIds) ===
            JSON.stringify(request.subscriptionIds)
        ) {
          return active.id
        }
        throw new Error('Another job is already active')
      }

      const id = newId()
      const createdAt = now()
      const currentAtStart = fingerprintConfig(await loadConfig())
      const fingerprint = request.fingerprint ?? currentAtStart
      const controller = new AbortController()
      jobs.set(id, {
        id,
        state: 'pending',
        progress: 0,
        createdAt,
        updatedAt: createdAt,
        subscriptionIds: request.subscriptionIds,
        fingerprint,
        fingerprintSource: request.fingerprint ? 'request' : 'config',
      })
      expiredErrors.delete(id)
      applyResults.delete(id)
      results.delete(id)
      applied.delete(id)
      activeId = id
      controllers.set(id, controller)
      void persist()
      void runJob(id, request, controller)
      return id
    },

    async getStatus(id: string): Promise<JobStatus | undefined> {
      await ensureLoaded()
      enforceRetention(true)
      const job = jobs.get(id)
      return job
        ? publicStatus(job)
        : expiredStatus(id, expiredErrors.get(id) ?? 'Job not found')
    },

    async getResult(id: string): Promise<DetectionResult | undefined> {
      await ensureLoaded()
      enforceRetention(true)
      const job = jobs.get(id)
      const resultId = job?.resultId ?? (job ? id : undefined)
      const entry = resultId
        ? (results.get(resultId) ?? results.get(id))
        : undefined
      if (!entry) return undefined
      const result = structuredClone(entry.result)
      if (entry.subscriptionByTempName) {
        result.subscriptionByTempName = entry.subscriptionByTempName
      }
      if (entry.request.subscriptionIds.length > 0) {
        result.subscriptionIds = entry.request.subscriptionIds
      }
      return result
    },

    async cancel(id: string): Promise<boolean> {
      await ensureLoaded()
      const job = jobs.get(id)
      if (!job || (job.state !== 'pending' && job.state !== 'running')) {
        return false
      }
      controllers.get(id)?.abort()
      finish(id, { state: 'cancelled', progress: 100 })
      return true
    },

    async list(): Promise<JobStatus[]> {
      await ensureLoaded()
      return [...jobs.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(publicStatus)
    },

    async apply(id: string): Promise<ApplyResult | undefined> {
      await ensureLoaded()
      const job = jobs.get(id)
      if (!job) {
        throw new Error(
          expiredErrors.get(id) ? `Job ${id} expired` : `Job ${id} not found`,
        )
      }
      if (job.state !== 'completed') {
        throw new Error(`Job ${id} is ${job.state}, not completed`)
      }
      const entry = results.get(id)
      if (!entry) throw new Error(`Job ${id} expired`)
      if (entry.subscriptionByTempName) {
        entry.result.subscriptionByTempName = entry.subscriptionByTempName
      }
      if (entry.request.subscriptionIds.length > 0) {
        entry.result.subscriptionIds = entry.request.subscriptionIds
      }
      let current: string | undefined
      try {
        current = fingerprintConfig(await loadConfig())
      } catch {
        current = undefined
      }
      const jobFingerprint = job.fingerprint ?? entry.request.fingerprint
      if (
        current &&
        jobFingerprint &&
        current !== jobFingerprint &&
        job.fingerprintSource !== 'persisted'
      ) {
        throw new Error(
          `Job ${id} is stale: configuration changed after job start`,
        )
      }
      if (applyResults.has(id)) return applyResults.get(id)
      if (!opts.apply) {
        if (applied.has(id)) return undefined
        applied.add(id)
        applyResults.set(id, undefined)
        return undefined
      }
      const resultId = job.resultId ?? id
      updateJob(id, { resultId })
      const value = await opts.apply(resultId, entry.request)
      applied.add(id)
      applyResults.set(id, value ?? undefined)
      await persist()
      return value ?? undefined
    },

    async shutdown(): Promise<void> {
      shuttingDown = true
      for (const [id, controller] of controllers) {
        const job = jobs.get(id)
        controller.abort()
        if (job && (job.state === 'pending' || job.state === 'running')) {
          finish(id, { state: 'cancelled', progress: 100, error: 'shutdown' })
        }
      }
      await persistence
    },

    advanceClock(ms: number): void {
      opts.advanceTime?.(ms)
    },

    flush(): Promise<void> {
      return persistence
    },
  }
}
