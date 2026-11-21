import type {NodeCheckClass, NodeCheckConfigStore} from './config';
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  NODE_CHECK_CLASSES
  
  
} from './config'

export type ClassifiedNodeClass = NodeCheckClass | 'discard'

export interface ClassifiedSlice {
  class: ClassifiedNodeClass
  renamedNode: Record<string, unknown>
}

export type ClassifiedSlices = Record<string, Record<string, ClassifiedSlice>>

export interface ExportOptions {
  baseDir?: string
  recover?: boolean
  writeYaml?: (
    path: string,
    content: string,
    generation: number,
  ) => Promise<void>
}

export interface ExportResult {
  generation: number
  baseDir: string
}

export interface RecoverResult {
  generation?: number
  baseDir: string
}

const DEFAULT_BASE_DIR = '/data/node-sets'
const STAGING_DIR = '.staging'
const CURRENT_LINK = 'current'

const busy = new Map<string, Promise<void>>()

function resolveBaseDir(opts: ExportOptions): string {
  return resolve(opts.baseDir ?? process.env.NODE_SETS_DIR ?? DEFAULT_BASE_DIR)
}

function withExportLock<T>(
  baseDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const result = (busy.get(baseDir) ?? Promise.resolve()).then(action)
  const settled = result.then(
    () => {},
    () => {},
  )
  busy.set(baseDir, settled)
  void settled.then(() => {
    if (busy.get(baseDir) === settled) busy.delete(baseDir)
  })
  return result
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function defaultWriteYaml(
  path: string,
  content: string,
  _generation: number,
): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isCurrentSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function readCurrentGeneration(baseDir: string): number | undefined {
  const link = join(baseDir, CURRENT_LINK)
  if (!isCurrentSymlink(link)) return undefined
  try {
    const match = /^\.staging\/(\d+)$/.exec(readlinkSync(link))
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

async function flipCurrent(baseDir: string, generation: number): Promise<void> {
  const temporary = join(baseDir, `${CURRENT_LINK}.${randomUUID()}.tmp`)
  symlinkSync(`${STAGING_DIR}/${generation}`, temporary)
  await rename(temporary, join(baseDir, CURRENT_LINK))
  await fsyncDirectory(baseDir)
}

async function isCompleteGeneration(
  baseDir: string,
  generation: number,
): Promise<boolean> {
  const files = await Promise.all(
    NODE_CHECK_CLASSES.map(async (nodeClass) => {
      const path = join(
        baseDir,
        STAGING_DIR,
        String(generation),
        `${nodeClass}.yaml`,
      )
      if (!existsSync(path)) return undefined
      try {
        return parse(await readFile(path, 'utf8')) as unknown
      } catch {
        return undefined
      }
    }),
  )
  return files.every((content) => isProxyDocument(content))
}

function isProxyDocument(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).proxies)
  )
}

function stagingGenerations(baseDir: string): number[] {
  const staging = join(baseDir, STAGING_DIR)
  if (!existsSync(staging)) return []
  return readdirSync(staging, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right)
}

async function completeStagingGenerations(baseDir: string): Promise<number[]> {
  const complete: number[] = []
  for (const generation of stagingGenerations(baseDir)) {
    if (await isCompleteGeneration(baseDir, generation))
      complete.push(generation)
  }
  return complete
}

async function reconcile(
  store: NodeCheckConfigStore,
  baseDir: string,
  recover: boolean,
  generationFloor: number,
): Promise<number> {
  await mkdir(baseDir, { recursive: true })
  await mkdir(join(baseDir, STAGING_DIR), { recursive: true })
  const config = await store.readConfig()
  const configuredGenerations = NODE_CHECK_CLASSES.flatMap((nodeClass) => {
    const generation = config.exports[nodeClass]?.generation
    return generation === undefined ? [] : [generation]
  })
  const declaredGeneration =
    configuredGenerations.length > 0
      ? Math.max(...configuredGenerations)
      : undefined
  const link = join(baseDir, CURRENT_LINK)
  const linkedGeneration = readCurrentGeneration(baseDir)
  const linkedComplete =
    linkedGeneration !== undefined &&
    (await isCompleteGeneration(baseDir, linkedGeneration))

  if (!linkedComplete && linkedGeneration !== undefined) {
    await rm(link, { force: true })
  }

  let keptGeneration = linkedComplete ? linkedGeneration : undefined
  let restoredGeneration: number | undefined

  if (
    linkedComplete &&
    declaredGeneration !== undefined &&
    linkedGeneration !== declaredGeneration &&
    (await isCompleteGeneration(baseDir, declaredGeneration))
  ) {
    await flipCurrent(baseDir, declaredGeneration)
    keptGeneration = declaredGeneration
  }

  if (keptGeneration === undefined && recover) {
    const preferred = declaredGeneration ?? 0
    const candidates = [
      ...(declaredGeneration === undefined ? [] : [declaredGeneration]),
      ...stagingGenerations(baseDir)
        .filter((generation) => generation !== declaredGeneration)
        .reverse(),
    ]
    for (const generation of candidates) {
      if (generation < preferred && declaredGeneration !== undefined) continue
      if (await isCompleteGeneration(baseDir, generation)) {
        await flipCurrent(baseDir, generation)
        keptGeneration = generation
        restoredGeneration = generation
        break
      }
    }
  }

  const generations = new Set([
    ...(keptGeneration === undefined ? [] : [keptGeneration]),
    ...(recover
      ? await completeStagingGenerations(baseDir)
      : configuredGenerations),
  ])

  const staleGenerations = new Set<number>()
  for (const generation of stagingGenerations(baseDir)) {
    const complete = await isCompleteGeneration(baseDir, generation)
    if (!generations.has(generation) && !complete) {
      staleGenerations.add(generation)
      if (generation !== keptGeneration) {
        await rm(join(baseDir, STAGING_DIR, String(generation)), {
          recursive: true,
          force: true,
        })
      }
    }
  }
  await fsyncDirectory(join(baseDir, STAGING_DIR))

  if (restoredGeneration !== undefined) {
    const current = await store.readConfig()
    const recordsChanged = NODE_CHECK_CLASSES.some(
      (nodeClass) =>
        current.exports[nodeClass]?.generation !== restoredGeneration,
    )
    if (recordsChanged) {
      await store.writeConfig((config) => {
        for (const nodeClass of NODE_CHECK_CLASSES) {
          config.exports[nodeClass] = {
            providerName: `nc-${nodeClass}`,
            filePath: `${DEFAULT_BASE_DIR}/${CURRENT_LINK}/${nodeClass}.yaml`,
            generation: restoredGeneration,
          }
        }
      })
    }
  }

  return Math.max(
    generationFloor,
    ...staleGenerations,
    ...configuredGenerations,
  )
}

export async function recoverNodeSets(
  store: NodeCheckConfigStore,
  opts: ExportOptions = {},
): Promise<RecoverResult> {
  const baseDir = resolveBaseDir(opts)
  return withExportLock(baseDir, async () => {
    const config = await store.readConfig()
    const generation = Math.max(
      0,
      ...NODE_CHECK_CLASSES.flatMap((nodeClass) => {
        const value = config.exports[nodeClass]?.generation
        return value === undefined ? [] : [value]
      }),
    )
    await reconcile(store, baseDir, true, generation)
    return {
      ...(readCurrentGeneration(baseDir) === undefined
        ? {}
        : { generation: readCurrentGeneration(baseDir) }),
      baseDir,
    }
  })
}

function aggregateSlices(
  slices: ClassifiedSlices,
): Record<NodeCheckClass, Record<string, unknown>[]> {
  const proxies: Record<NodeCheckClass, Record<string, unknown>[]> = {
    ai: [],
    streaming: [],
    download: [],
  }

  for (const subscriptionId of Object.keys(slices).sort()) {
    const subscription = slices[subscriptionId] ?? {}
    for (const tempName of Object.keys(subscription).sort()) {
      const entry = subscription[tempName]
      if (!entry || entry.class === 'discard') continue
      proxies[entry.class].push(structuredClone(entry.renamedNode))
    }
  }
  return proxies
}

function renderYaml(proxies: readonly Record<string, unknown>[]): string {
  if (proxies.length === 0) return 'proxies: []\n'
  return stringify({ proxies }, { lineWidth: 0 })
}

export async function exportNodeSets(
  store: NodeCheckConfigStore,
  slices: ClassifiedSlices,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const baseDir = resolveBaseDir(opts)
  return withExportLock(baseDir, async () => {
    const config = await store.readConfig()
    const nextGeneration =
      Math.max(
        0,
        ...NODE_CHECK_CLASSES.flatMap((nodeClass) => {
          const value = config.exports[nodeClass]?.generation
          return value === undefined ? [] : [value]
        }),
        readCurrentGeneration(baseDir) ?? 0,
        ...stagingGenerations(baseDir),
      ) + 1
    await reconcile(store, baseDir, opts.recover === true, nextGeneration)
    const generation = nextGeneration
    const stagingDir = join(baseDir, STAGING_DIR, String(generation))
    await mkdir(stagingDir, { recursive: false, mode: 0o700 })
    const writeYaml = opts.writeYaml ?? defaultWriteYaml
    const proxies = aggregateSlices(slices)

    try {
      for (const nodeClass of NODE_CHECK_CLASSES) {
        await writeYaml(
          join(stagingDir, `${nodeClass}.yaml`),
          renderYaml(proxies[nodeClass]),
          generation,
        )
      }
      await fsyncDirectory(stagingDir)

      await flipCurrent(baseDir, generation)

      await store.writeConfig((current) => {
        for (const nodeClass of NODE_CHECK_CLASSES) {
          current.exports[nodeClass] = {
            providerName: `nc-${nodeClass}`,
            filePath: `${DEFAULT_BASE_DIR}/${CURRENT_LINK}/${nodeClass}.yaml`,
            generation,
          }
        }
      })

      for (const oldGeneration of stagingGenerations(baseDir)) {
        if (oldGeneration !== generation) {
          await rm(join(baseDir, STAGING_DIR, String(oldGeneration)), {
            recursive: true,
            force: true,
          })
        }
      }
      await fsyncDirectory(join(baseDir, STAGING_DIR))
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }

    return { generation, baseDir }
  })
}
