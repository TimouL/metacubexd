import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNodeCheckConfigStore,
  DEFAULT_NODE_CHECK_CONFIG,
  getNodeCheckConfigPath,
} from './config'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mcxd-node-check-config-'))
}

describe('node-check config', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  it('derives /data/node-check-config.json from DATA_DIR', () => {
    expect(getNodeCheckConfigPath('/data')).toBe('/data/node-check-config.json')
  })

  it('defaults the store path to DATA_DIR/node-check-config.json', () => {
    const previous = process.env.DATA_DIR
    process.env.DATA_DIR = dir
    try {
      expect(createNodeCheckConfigStore().path).toBe(
        join(dir, 'node-check-config.json'),
      )
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previous
    }
  })

  it('reads defaults when the config file is missing', async () => {
    const store = createNodeCheckConfigStore({ dir })

    expect(await store.readConfig()).toEqual(DEFAULT_NODE_CHECK_CONFIG)
  })

  it('merges valid partial config over defaults', async () => {
    writeFileSync(
      join(dir, 'node-check-config.json'),
      JSON.stringify({
        tags: { sub1: 'free组' },
        settings: { minSpeedBytes: 2_000_000 },
      }),
    )
    const store = createNodeCheckConfigStore({ dir })

    const config = await store.readConfig()

    expect(config.tags).toEqual({ sub1: 'free组' })
    expect(config.settings.minSpeedBytes).toBe(2_000_000)
    expect(config.settings.speedTiers).toEqual(
      DEFAULT_NODE_CHECK_CONFIG.settings.speedTiers,
    )
    expect(config.refreshTransport).toEqual({})
    expect(config.exports).toEqual({})
    expect(config.jobs).toEqual(DEFAULT_NODE_CHECK_CONFIG.jobs)
  })

  it('preserves a corrupt config as .corrupt and starts fresh', async () => {
    const path = join(dir, 'node-check-config.json')
    writeFileSync(path, '{not json')
    const store = createNodeCheckConfigStore({ dir })

    expect(await store.readConfig()).toEqual(DEFAULT_NODE_CHECK_CONFIG)
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{not json')
    expect(readFileSync(path, 'utf8')).toBe(
      `${JSON.stringify(DEFAULT_NODE_CHECK_CONFIG, null, 2)}\n`,
    )
  })

  it('normalizes malformed field types to defaults', async () => {
    writeFileSync(
      join(dir, 'node-check-config.json'),
      JSON.stringify({
        schemaVersion: '1',
        tags: [],
        refreshTransport: {
          sub1: { mode: 'bogus' },
          sub2: { mode: 'generalProxy', proxyId: 7 },
          sub3: { mode: 'githubProxy' },
        },
        githubProxies: [
          { id: 'p1', prefix: 'https://gh.example/', enabled: 'yes' },
          { id: 'p2', prefix: 42 },
        ],
        generalProxy: 3,
        settings: {
          minSpeedBytes: -1,
          speedTiers: [3_000_000, 1_000_000, 1_000_000],
          regionNames: { 美国: 1 },
        },
        exports: {
          ai: { providerName: 'nc-ai', filePath: 'ai.yaml', generation: -2 },
          streaming: null,
        },
        jobs: { activeJobId: 5, completed: 'none' },
      }),
    )
    const store = createNodeCheckConfigStore({ dir })

    const config = await store.readConfig()

    expect(config.schemaVersion).toBe(DEFAULT_NODE_CHECK_CONFIG.schemaVersion)
    expect(config.tags).toEqual({})
    expect(config.refreshTransport).toEqual({
      sub2: { mode: 'generalProxy' },
      sub3: { mode: 'githubProxy' },
    })
    expect(config.githubProxies).toEqual([
      { id: 'p1', prefix: 'https://gh.example/', enabled: false },
    ])
    expect(config.generalProxy).toBeUndefined()
    expect(config.settings).toEqual({
      minSpeedBytes: DEFAULT_NODE_CHECK_CONFIG.settings.minSpeedBytes,
      speedTiers: [1_000_000, 3_000_000],
      regionNames: DEFAULT_NODE_CHECK_CONFIG.settings.regionNames,
    })
    expect(config.exports).toEqual({
      ai: { providerName: 'nc-ai', filePath: 'ai.yaml', generation: 0 },
    })
    expect(config.jobs).toEqual({
      activeJobId: undefined,
      completed: DEFAULT_NODE_CHECK_CONFIG.jobs.completed,
    })
  })

  it('writeConfig serializes read/modify/write updates', async () => {
    const store = createNodeCheckConfigStore({ dir })
    const releases: Array<() => void> = []
    let started: () => void = () => {}
    const mutatorStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const barriers = Array.from(
      { length: 2 },
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        }),
    )
    let calls = 0
    const mutator = vi.fn(async (config) => {
      const release = barriers[calls]!
      calls++
      config.tags[`sub${calls}`] = `tag${calls}`
      started()
      await release
    })

    const first = store.writeConfig(mutator)
    const second = store.writeConfig((config) => {
      expect(config.tags).toEqual({ sub1: 'tag1' })
      config.tags.sub2 = 'tag2'
    })
    await mutatorStarted
    releases[0]!()
    await first
    releases[1]!()
    await second

    expect(mutator).toHaveBeenCalledTimes(1)
    expect((await store.readConfig()).tags).toEqual({
      sub1: 'tag1',
      sub2: 'tag2',
    })
  })

  it('writeConfig writes atomically with a temp file and rename', async () => {
    const store = createNodeCheckConfigStore({ dir })

    await store.writeConfig((config) => {
      config.tags.sub1 = 'tag1'
    })

    expect(readdirSync(dir)).toEqual(['node-check-config.json'])
    expect(
      JSON.parse(readFileSync(join(dir, 'node-check-config.json'), 'utf8')),
    ).toMatchObject({ tags: { sub1: 'tag1' } })
  })
})
