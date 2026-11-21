import type {NodeCheckClass as ConfigNodeCheckClass, NodeCheckClass} from './config';
import type {ClassifiedSlice} from './export';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  
  createNodeCheckConfigStore
  
} from './config'
import {  exportNodeSets, recoverNodeSets } from './export'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mcxd-node-check-export-'))
}

function proxy(name: string, server = `${name}.example.com`) {
  return {
    name,
    type: 'ss',
    server,
    port: 8388,
    cipher: 'aes-256-gcm',
    password: `${name}-secret`,
  }
}

function slice(
  nodeClass: ConfigNodeCheckClass | 'discard',
  name: string,
): ClassifiedSlice {
  return {
    class: nodeClass,
    renamedNode: proxy(name),
  }
}

function publication(nodeClass: NodeCheckClass, generation: number) {
  return {
    providerName: `nc-${nodeClass}`,
    filePath: `/data/node-sets/current/${nodeClass}.yaml`,
    generation,
  }
}

function currentGeneration(dir: string): number {
  const target = readlinkSync(join(dir, 'current'))
  const match = /\.staging\/(\d+)$/.exec(target)
  if (!match) throw new Error(`Unexpected current symlink target: ${target}`)
  return Number(match[1])
}

function currentGenerationFromConfig(config: {
  exports: Record<string, { generation: number } | undefined>
}): number {
  return Math.max(
    0,
    ...Object.values(config.exports).map((entry) => entry?.generation ?? 0),
  )
}

function readCurrentYaml(dir: string, nodeClass: NodeCheckClass) {
  return parse(
    readFileSync(join(dir, 'current', `${nodeClass}.yaml`), 'utf8'),
  ) as { proxies: Array<Record<string, unknown>> }
}

function proxyNames(dir: string, nodeClass: NodeCheckClass): string[] {
  return readCurrentYaml(dir, nodeClass).proxies.map((entry) =>
    String(entry.name),
  )
}

describe('node-check transactional export', () => {
  let dataDir: string
  let baseDir: string
  let store: ReturnType<typeof createNodeCheckConfigStore>

  beforeEach(() => {
    dataDir = tmpDir()
    baseDir = join(dataDir, 'node-sets')
    store = createNodeCheckConfigStore({ dir: dataDir })
  })

  it('rebuilds all aggregate YAML files from per-subscription slices', async () => {
    const result = await exportNodeSets(
      store,
      {
        sub1: {
          __nc_0001: slice('ai', 'sub1-ai'),
          __nc_0002: slice('streaming', 'sub1-stream'),
          __nc_0003: slice('discard', 'sub1-dead'),
        },
        sub2: {
          __nc_0004: slice('download', 'sub2-download'),
          __nc_0005: slice('ai', 'sub2-ai'),
        },
      },
      { baseDir },
    )

    expect(result.generation).toBe(1)
    expect(proxyNames(baseDir, 'ai')).toEqual(['sub1-ai', 'sub2-ai'])
    expect(proxyNames(baseDir, 'streaming')).toEqual(['sub1-stream'])
    expect(proxyNames(baseDir, 'download')).toEqual(['sub2-download'])
    expect((await store.readConfig()).exports).toEqual({
      ai: publication('ai', 1),
      streaming: publication('streaming', 1),
      download: publication('download', 1),
    })
  })

  it('replaces one subscription without disturbing the others', async () => {
    const initial = {
      sub1: {
        __nc_0001: slice('ai', 'sub1-old'),
        __nc_0002: slice('download', 'sub1-download'),
      },
      sub2: {
        __nc_0003: slice('ai', 'sub2-ai'),
      },
    }
    await exportNodeSets(store, initial, { baseDir })

    await exportNodeSets(
      store,
      {
        sub1: {
          __nc_0001: slice('streaming', 'sub1-new'),
        },
        sub2: initial.sub2,
      },
      { baseDir },
    )

    expect(proxyNames(baseDir, 'ai')).toEqual(['sub2-ai'])
    expect(proxyNames(baseDir, 'streaming')).toEqual(['sub1-new'])
    expect(proxyNames(baseDir, 'download')).toEqual([])
    expect(currentGeneration(baseDir)).toBe(2)
  })

  it('publishes all classes through one atomic symlink flip', async () => {
    const result = await exportNodeSets(store, {}, { baseDir })

    expect(result.generation).toBe(1)
    expect(readlinkSync(join(baseDir, 'current'))).toBe('.staging/1')
    expect(realpathSync(join(baseDir, 'current'))).toBe(
      join(baseDir, '.staging', '1'),
    )
    for (const nodeClass of ['ai', 'streaming', 'download'] as const) {
      expect(
        readFileSync(
          join(baseDir, '.staging', '1', `${nodeClass}.yaml`),
          'utf8',
        ),
      ).toBe('proxies: []\n')
    }
  })

  it('keeps the last-good symlink and removes orphan staging during recovery', async () => {
    await exportNodeSets(
      store,
      {
        sub1: { __nc_0001: slice('ai', 'good') },
      },
      { baseDir },
    )

    mkdirSync(join(baseDir, '.staging', '2'), { recursive: true })
    writeFileSync(join(baseDir, '.staging', '2', 'ai.yaml'), 'proxies: []\n')
    mkdirSync(join(baseDir, '.staging', '3'), { recursive: true })
    const { writeFileSync: write } = await import('node:fs')
    for (const nodeClass of ['ai', 'streaming', 'download'] as const) {
      write(
        join(baseDir, '.staging', '2', `${nodeClass}.yaml`),
        'proxies: []\n',
      )
    }

    await recoverNodeSets(store, { baseDir })

    expect(currentGeneration(baseDir)).toBe(1)
    expect(proxyNames(baseDir, 'ai')).toEqual(['good'])
    expect(readdirSync(join(baseDir, '.staging'))).toEqual(['1', '2'])
    expect((await store.readConfig()).exports.ai?.generation).toBe(1)
    expect(currentGenerationFromConfig(await store.readConfig())).toBe(1)
  })

  it('recovers to the newest complete staging generation when config is lost', async () => {
    await exportNodeSets(
      store,
      {
        sub1: { __nc_0001: slice('ai', 'first') },
      },
      { baseDir },
    )

    const { renameSync } = await import('node:fs')

    mkdirSync(join(baseDir, '.staging', '2'), { recursive: true })
    for (const nodeClass of ['ai', 'streaming', 'download'] as const) {
      writeFileSync(
        join(baseDir, '.staging', '2', `${nodeClass}.yaml`),
        nodeClass === 'ai'
          ? 'proxies:\n  - name: recovered\n    type: ss\n'
          : 'proxies: []\n',
      )
    }

    renameSync(join(baseDir, 'current'), join(baseDir, 'current.broken'))
    const configPath = join(dataDir, 'node-check-config.json')
    rmSync(configPath)
    const freshStore = createNodeCheckConfigStore({ dir: dataDir })

    await recoverNodeSets(freshStore, { baseDir })

    expect(currentGeneration(baseDir)).toBe(2)
    expect(proxyNames(baseDir, 'ai')).toEqual(['recovered'])
    expect((await freshStore.readConfig()).exports.ai?.generation).toBe(2)
    expect(readdirSync(baseDir)).toContain('current.broken')
  })

  it('clears stale nodes on a successful empty export', async () => {
    await exportNodeSets(
      store,
      {
        sub1: {
          __nc_0001: slice('ai', 'stale-ai'),
          __nc_0002: slice('download', 'stale-download'),
        },
      },
      { baseDir },
    )

    const result = await exportNodeSets(store, {}, { baseDir })

    expect(result.generation).toBe(2)
    for (const nodeClass of ['ai', 'streaming', 'download'] as const) {
      expect(proxyNames(baseDir, nodeClass)).toEqual([])
    }
  })

  it('preserves the prior generation when generation fails', async () => {
    await exportNodeSets(
      store,
      {
        sub1: { __nc_0001: slice('ai', 'keep-me') },
      },
      { baseDir },
    )
    const before = await store.readConfig()

    await expect(
      exportNodeSets(
        store,
        {},
        {
          baseDir,
          writeYaml: async () => {
            throw new Error('disk full')
          },
        },
      ),
    ).rejects.toThrow('disk full')

    expect(currentGeneration(baseDir)).toBe(1)
    expect(proxyNames(baseDir, 'ai')).toEqual(['keep-me'])
    expect((await store.readConfig()).exports).toEqual(before.exports)
  })

  it('serializes concurrent exports without publishing overlapping generations', async () => {
    const writes: Array<{ generation: number; path: string }> = []
    const writeYaml = vi.fn(
      async (path: string, _content: string, generation: number) => {
        writes.push({ generation, path })
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, 'proxies: []\n')
      },
    )

    const first = exportNodeSets(store, {}, { baseDir, writeYaml })
    const second = first.then(() =>
      exportNodeSets(store, {}, { baseDir, writeYaml }),
    )
    const third = first.then(() =>
      exportNodeSets(store, {}, { baseDir, writeYaml }),
    )

    await expect(first).resolves.toMatchObject({ generation: 1 })
    expect(currentGeneration(baseDir)).toBe(1)
    expect([...new Set(writes.map((entry) => entry.generation))]).toEqual([1])

    await expect(second).resolves.toMatchObject({ generation: 2 })
    expect(currentGeneration(baseDir)).toBe(2)
    expect([...new Set(writes.map((entry) => entry.generation))]).toEqual([
      1, 2,
    ])

    await expect(third).resolves.toMatchObject({ generation: 3 })
    expect(currentGeneration(baseDir)).toBe(3)
    expect((await store.readConfig()).exports.download?.generation).toBe(3)
    expect(writes.filter((entry) => entry.generation === 1)).toHaveLength(3)
    expect(writes.filter((entry) => entry.generation === 2)).toHaveLength(3)
    expect(writes.filter((entry) => entry.generation === 3)).toHaveLength(3)
  })
})
