import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const uiDir = resolve(process.cwd())
const read = (path: string) => readFileSync(resolve(uiDir, path), 'utf8')

describe('node-check page', () => {
  it('renders all required sections and controls', () => {
    const page = read('pages/node-check.vue')
    for (const text of [
      'nodeCheckSubscriptions',
      'nodeCheckBulkPlaceholder',
      'nodeCheckGithubProxies',
      'nodeCheckDetect',
      'nodeCheckResults',
      'nodeCheckExport',
      '@click="startDetection"',
      'copyText(resultProviderSnippet)',
    ]) {
      expect(page, text).toContain(text)
    }
    expect(page).toContain(':value="progress"')
    expect(page).toContain('node.renamed ?? node.name')
  })

  it('gates desktop and mobile navigation on node-check capability', () => {
    const desktop = read('components/Sidebar.vue')
    const mobile = read('components/MobileBottomNav.vue')
    for (const source of [desktop, mobile]) {
      expect(source).toContain("hasFeature('node-check')")
      expect(source).toContain("href: '/node-check'")
      expect(source).toContain('IconListCheck')
    }
  })

  it('ships Chinese copy and English fallbacks for every node-check key', () => {
    const zh = JSON.parse(read('i18n/locales/zh.json')) as Record<
      string,
      string
    >
    expect(zh.nodeCheck).toBe('节点检测')
    expect(zh.nodeCheckTransportGithubProxy).toBe('GitHub 代理')
    expect(zh.nodeCheckSpeed).toBe('速度（MB/s）')
    for (const code of ['en', 'ru', 'ja', 'ko', 'fr', 'fa']) {
      const locale = JSON.parse(read(`i18n/locales/${code}.json`)) as Record<
        string,
        string
      >
      expect(locale.nodeCheck, code).toBe('Node Check')
      expect(locale.nodeCheckApplyFailed, code).toBe('Export failed')
    }
  })
})
