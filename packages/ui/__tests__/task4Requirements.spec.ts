import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const uiDir = resolve(process.cwd())
const read = (path: string) => readFileSync(resolve(uiDir, path), 'utf8')

describe('task4 requirements', () => {
  it('saves the visual editor without activating', () => {
    const source = read('pages/profiles/[id]/edit.vue')
    expect(source).toContain(
      'api.applyProfileEditor(profileId.value, currentPatch(), {\n      activate: false,\n    })',
    )
    expect(source).not.toMatch(/activeApplyLabel/)
    expect(source).toContain(':title="t(\'tooltipAddProxy\')"')
    expect(source).toContain(':title="t(\'tooltipAddProvider\')"')
  })

  it('uses validate-and-save wording in every locale', () => {
    const expected: Record<string, { apply: string; activate: string }> = {
      en: { apply: 'Validate and save', activate: 'Validate and save' },
      zh: { apply: '验证并保存', activate: '验证并保存' },
      ru: { apply: 'Проверить и сохранить', activate: 'Проверить и сохранить' },
      ja: { apply: '検証して保存', activate: '検証して保存' },
      ko: { apply: '검증 후 저장', activate: '검증 후 저장' },
      fr: {
        apply: 'Valider et enregistrer',
        activate: 'Valider et enregistrer',
      },
      fa: { apply: 'اعتبارسنجی و ذخیره', activate: 'اعتبارسنجی و ذخیره' },
    }
    for (const [code, wording] of Object.entries(expected)) {
      const locale = JSON.parse(read(`i18n/locales/${code}.json`)) as Record<
        string,
        string
      >
      expect(locale.visualEditorApply, code).toBe(wording.apply)
      expect(locale.visualEditorActivate, code).toBe(wording.activate)
      expect(locale.tooltipAddProxy, code).toBeTruthy()
      expect(locale.tooltipAddProvider, code).toBeTruthy()
    }
    const zh = JSON.parse(read('i18n/locales/zh.json')) as Record<
      string,
      string
    >
    expect(zh.visualEditorApply).toBe('验证并保存')
    expect(zh.visualEditorActivate).toBe('验证并保存')
    expect(zh.tooltipAddProxy).toBe('添加节点')
    expect(zh.tooltipAddProvider).toBe('添加订阅供应商')
  })
})
