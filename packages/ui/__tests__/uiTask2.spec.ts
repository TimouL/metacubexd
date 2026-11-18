import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const uiDir = resolve(process.cwd())
const read = (path: string) => readFileSync(resolve(uiDir, path), 'utf8')

describe('task2 UI requirements', () => {
  it('button supports a native title tooltip', () => {
    const source = read('components/Button.vue')
    expect(source).toMatch(/title\?:\s*string/)
    expect(source).toMatch(/:title="title"/)
  })

  it('profile action buttons expose Chinese tooltips', () => {
    const profiles = read('pages/profiles.vue')
    for (const key of [
      'tooltipVisualEditor',
      'tooltipProfilesEdit',
      'tooltipProfilesRefresh',
      'tooltipRefreshAndApply',
      'tooltipProfilesDuplicate',
      'tooltipProfilesShare',
      'tooltipProfilesDelete',
      'tooltipProfilesSave',
      'tooltipProfilesValidate',
      'tooltipProfilesCancel',
      'subscriptionProviderPickerAction',
    ]) {
      expect(profiles, key).toContain(`:title="t('${key}')"`)
    }

    const fullEditor = read('pages/profiles/[id]/edit.vue')
    for (const key of [
      'tooltipVisualEditor',
      'visualEditorVisual',
      'subscriptionProviderPickerAction',
      'visualEditorPreview',
      'visualEditorApply',
      'visualEditorReset',
      'visualEditorBack',
    ]) {
      expect(fullEditor, key).toContain(`:title="t('${key}')"`)
    }
  })

  it('adds gated profiles entry to the mobile secondary navigation', () => {
    const source = read('components/MobileBottomNav.vue')
    expect(source).toContain('IconFileCode')
    expect(source).toContain('hasFeature')
    expect(source).toContain("href: '/profiles'")
  })

  it('ships Simplified Chinese tooltip copy', () => {
    const zh = JSON.parse(read('i18n/locales/zh.json')) as Record<
      string,
      string
    >
    expect(zh.tooltipVisualEditor).toBe('打开可视化编辑器')
    expect(zh.tooltipProfilesEdit).toBe('编辑配置文件内容')
    expect(zh.tooltipRefreshAndApply).toBe('刷新订阅并立即应用')
    expect(zh.tooltipProfilesSave).toBe('保存配置文件')
  })
})
