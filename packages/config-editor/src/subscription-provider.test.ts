import { describe, expect, it } from 'vitest'
import { addSubscriptionProxyProvider, openDocument } from './index'

describe('addSubscriptionProxyProvider', () => {
  it('creates a provider and adds it to every select or url-test group', () => {
    const source = `# keep this comment\nmode: rule\nproxy-groups:\n  - name: Choose\n    type: select\n    proxies: [DIRECT]\n  - name: Fast\n    type: url-test\n    proxies: [DIRECT]\n  - name: Ignore\n    type: fallback\n    proxies: [DIRECT]\n`
    const result = addSubscriptionProxyProvider(source, {
      name: 'My Sub',
      url: 'https://example.test/subscription',
    })

    expect(result.data['proxy-providers']).toEqual({
      'My Sub': {
        type: 'http',
        url: 'https://example.test/subscription',
        interval: 21_600,
        'health-check': {
          enable: true,
          url: 'https://www.gstatic.com/generate_204',
          interval: 600,
          lazy: true,
        },
        override: { 'additional-prefix': '[My Sub] ' },
      },
    })
    const groups = result.data['proxy-groups'] as Array<{
      name: string
      type: string
      use?: string[]
    }>
    expect(groups.find((group) => group.name === 'Choose')?.use).toEqual([
      'My Sub',
    ])
    expect(groups.find((group) => group.name === 'Fast')?.use).toEqual([
      'My Sub',
    ])
    expect(groups.find((group) => group.name === 'Ignore')?.use).toBeUndefined()
    expect(result.yaml).toContain('# keep this comment')
    expect(result.diagnostics).toEqual([])
  })

  it('appends to existing use lists without duplicating references', () => {
    const source = `proxy-providers:\n  Existing:\n    type: http\n    url: https://old.test/sub\nproxy-groups:\n  - name: Choose\n    type: select\n    proxies: [DIRECT]\n    use: [Existing]\n`
    const result = addSubscriptionProxyProvider(source, {
      name: 'Existing',
      url: 'https://example.test/subscription',
    })

    const providers = result.data['proxy-providers'] as Record<string, unknown>
    expect(Object.keys(providers)).toEqual(['Existing', 'Existing 2'])
    const groups = result.data['proxy-groups'] as Array<{ use?: string[] }>
    expect(groups[0]?.use).toEqual(['Existing', 'Existing 2'])
  })

  it('reuses a provider that already has the same URL', () => {
    const source = `proxy-providers:\n  Renamed:\n    type: http\n    url: https://example.test/subscription\nproxy-groups:\n  - name: Choose\n    type: select\n    proxies: [DIRECT]\n`
    const result = addSubscriptionProxyProvider(source, {
      name: 'Different name',
      url: 'https://example.test/subscription',
    })

    const providers = result.data['proxy-providers'] as Record<string, unknown>
    expect(providers).toBeTypeOf('object')
    expect(Object.keys(providers)).toEqual(['Renamed'])
    const groups = result.data['proxy-groups'] as Array<{ use?: string[] }>
    expect(groups[0]?.use).toEqual(['Renamed'])
  })

  it('preserves provider order and untouched group fields', () => {
    const source = `proxy-groups:\n  - name: Choose\n    type: select\n    proxies: [DIRECT]\n    url: https://example.test/group-health\n`
    const result = addSubscriptionProxyProvider(source, {
      name: 'My Sub',
      url: 'https://example.test/subscription',
    })

    const groups = result.data['proxy-groups'] as Array<Record<string, unknown>>
    expect(Object.keys(groups[0]!)).toEqual([
      'name',
      'type',
      'proxies',
      'url',
      'use',
    ])
    expect(openDocument(result.yaml).data).toEqual(result.data)
  })

  it('rejects invalid YAML through the document parser', () => {
    expect(() =>
      addSubscriptionProxyProvider('proxy-groups: [', {
        name: 'My Sub',
        url: 'https://example.test/subscription',
      }),
    ).toThrow(/Invalid YAML/)
  })
})
