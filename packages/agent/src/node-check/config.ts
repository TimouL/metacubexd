import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const NODE_CHECK_SCHEMA_VERSION = 1

export const NODE_CHECK_CLASSES = ['ai', 'streaming', 'download'] as const

export type NodeCheckClass = (typeof NODE_CHECK_CLASSES)[number]

export type RefreshTransportMode = 'direct' | 'generalProxy' | 'githubProxy'

export interface RefreshTransport {
  mode: RefreshTransportMode
  proxyId?: string
}

export interface GithubProxy {
  id: string
  prefix: string
  enabled: boolean
}

export interface NodeCheckSettings {
  minSpeedBytes: number
  speedTiers: number[]
  regionNames: Record<string, string>
}

export interface ExportRecord {
  providerName: string
  filePath: string
  generation: number
}

export interface NodeCheckJobs {
  activeJobId?: string
  completed: unknown[]
}

export interface NodeCheckConfig {
  schemaVersion: number
  tags: Record<string, string>
  refreshTransport: Record<string, RefreshTransport>
  githubProxies: GithubProxy[]
  generalProxy?: string
  settings: NodeCheckSettings
  exports: Partial<Record<NodeCheckClass, ExportRecord>>
  jobs: NodeCheckJobs
}

export const DEFAULT_NODE_CHECK_CONFIG: NodeCheckConfig = {
  schemaVersion: NODE_CHECK_SCHEMA_VERSION,
  tags: {},
  refreshTransport: {},
  githubProxies: [],
  settings: {
    minSpeedBytes: 1_048_576,
    speedTiers: [1_048_576, 3_145_728, 5_242_880, 10_485_760],
    regionNames: {
      美国: '美国',
      香港: '香港',
      日本: '日本',
      新加坡: '新加坡',
      其他: '其他',
    },
  },
  exports: {},
  jobs: { completed: [] },
}

export interface NodeCheckConfigStoreOptions {
  dir?: string
  path?: string
}

export interface NodeCheckConfigStore {
  readonly path: string
  readConfig: () => Promise<NodeCheckConfig>
  writeConfig: (
    mutator: (config: NodeCheckConfig) => void | Promise<void>,
  ) => Promise<NodeCheckConfig>
}

const writes = new Map<string, Promise<void>>()

function withNodeCheckWrite<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = resolve(path)
  const result = (writes.get(key) ?? Promise.resolve()).then(action)
  const settled = result.then(
    () => {},
    () => {},
  )
  writes.set(key, settled)
  void settled.then(() => {
    if (writes.get(key) === settled) writes.delete(key)
  })
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && Number.isInteger(number) && number >= 0
    ? number
    : undefined
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

function regionNames(value: unknown): Record<string, string> {
  const result = stringRecord(value)
  return Object.keys(result).length > 0
    ? result
    : { ...DEFAULT_NODE_CHECK_CONFIG.settings.regionNames }
}

function refreshTransport(value: unknown): RefreshTransport | undefined {
  if (!isPlainObject(value)) return undefined
  const modes: RefreshTransportMode[] = [
    'direct',
    'generalProxy',
    'githubProxy',
  ]
  if (typeof value.mode !== 'string' || !modes.includes(value.mode as never)) {
    return undefined
  }
  return {
    mode: value.mode as RefreshTransportMode,
    ...(typeof value.proxyId === 'string' ? { proxyId: value.proxyId } : {}),
  }
}

function githubProxies(value: unknown): GithubProxy[] {
  if (!Array.isArray(value)) return []
  const result: GithubProxy[] = []
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.prefix !== 'string'
    ) {
      continue
    }
    result.push({
      id: entry.id,
      prefix: entry.prefix,
      enabled: entry.enabled === true,
    })
  }
  return result
}

function settings(value: unknown): NodeCheckSettings {
  if (!isPlainObject(value)) {
    return structuredClone(DEFAULT_NODE_CHECK_CONFIG.settings)
  }
  const minSpeedBytes = nonNegativeInteger(value.minSpeedBytes)
  const rawTiers = Array.isArray(value.speedTiers)
    ? value.speedTiers
        .map(nonNegativeInteger)
        .filter((tier): tier is number => tier !== undefined)
    : []
  return {
    minSpeedBytes:
      minSpeedBytes ?? DEFAULT_NODE_CHECK_CONFIG.settings.minSpeedBytes,
    speedTiers:
      rawTiers.length > 0
        ? [...new Set(rawTiers)].sort((left, right) => left - right)
        : [...DEFAULT_NODE_CHECK_CONFIG.settings.speedTiers],
    regionNames: regionNames(value.regionNames),
  }
}

function exportsRecord(
  value: unknown,
): Partial<Record<NodeCheckClass, ExportRecord>> {
  if (!isPlainObject(value)) return {}
  const result: Partial<Record<NodeCheckClass, ExportRecord>> = {}
  for (const nodeClass of NODE_CHECK_CLASSES) {
    const entry = value[nodeClass]
    if (
      !isPlainObject(entry) ||
      typeof entry.providerName !== 'string' ||
      typeof entry.filePath !== 'string'
    ) {
      continue
    }
    result[nodeClass] = {
      providerName: entry.providerName,
      filePath: entry.filePath,
      generation: nonNegativeInteger(entry.generation) ?? 0,
    }
  }
  return result
}

function jobs(value: unknown): NodeCheckJobs {
  if (!isPlainObject(value)) {
    return structuredClone(DEFAULT_NODE_CHECK_CONFIG.jobs)
  }
  return {
    ...(typeof value.activeJobId === 'string'
      ? { activeJobId: value.activeJobId }
      : {}),
    completed: Array.isArray(value.completed) ? [...value.completed] : [],
  }
}

export function normalizeNodeCheckConfig(value: unknown): NodeCheckConfig {
  if (!isPlainObject(value)) {
    return structuredClone(DEFAULT_NODE_CHECK_CONFIG)
  }
  const transportEntries = isPlainObject(value.refreshTransport)
    ? Object.entries(value.refreshTransport)
    : []
  const refreshTransportEntries: Record<string, RefreshTransport> = {}
  for (const [id, entry] of transportEntries) {
    const normalized = refreshTransport(entry)
    if (normalized) refreshTransportEntries[id] = normalized
  }
  return {
    schemaVersion:
      finiteNumber(value.schemaVersion) ?? NODE_CHECK_SCHEMA_VERSION,
    tags: stringRecord(value.tags),
    refreshTransport: refreshTransportEntries,
    githubProxies: githubProxies(value.githubProxies),
    ...(typeof value.generalProxy === 'string'
      ? { generalProxy: value.generalProxy }
      : {}),
    settings: settings(value.settings),
    exports: exportsRecord(value.exports),
    jobs: jobs(value.jobs),
  }
}

export function getNodeCheckConfigPath(dir: string): string {
  return join(dir, 'node-check-config.json')
}

function resolveConfigPath(opts: NodeCheckConfigStoreOptions): string {
  if (opts.path) return opts.path
  return getNodeCheckConfigPath(opts.dir ?? process.env.DATA_DIR ?? '/data')
}

export function createNodeCheckConfigStore(
  opts: NodeCheckConfigStoreOptions = {},
): NodeCheckConfigStore {
  const path = resolveConfigPath(opts)
  const dir = join(path, '..')

  async function atomicWrite(content: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, content)
    try {
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async function readConfig(): Promise<NodeCheckConfig> {
    if (!existsSync(path)) return structuredClone(DEFAULT_NODE_CHECK_CONFIG)
    return readConfigUnlocked()
  }

  async function readConfigUnlocked(): Promise<NodeCheckConfig> {
    if (!existsSync(path)) return structuredClone(DEFAULT_NODE_CHECK_CONFIG)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return structuredClone(DEFAULT_NODE_CHECK_CONFIG)
    }
    try {
      return normalizeNodeCheckConfig(JSON.parse(raw) as unknown)
    } catch {
      await mkdir(dir, { recursive: true })
      await rename(path, `${path}.corrupt`)
      const fresh = structuredClone(DEFAULT_NODE_CHECK_CONFIG)
      await atomicWrite(`${JSON.stringify(fresh, null, 2)}\n`)
      return fresh
    }
  }

  return {
    path,
    readConfig,
    writeConfig(mutator) {
      return withNodeCheckWrite(path, async () => {
        const config = await readConfigUnlocked()
        await mutator(config)
        await atomicWrite(`${JSON.stringify(config, null, 2)}\n`)
        return config
      })
    },
  }
}
