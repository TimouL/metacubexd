import type { ConfigObject } from '@metacubexd/config-editor'
import { describe, expect, it } from 'vitest'
import { mergeSubscriptionProviderSections } from '../proxyConfigSubscriptionProviders'

describe('mergeSubscriptionProviderSections', () => {
  it('adds the provider and references it from eligible groups', () => {
    const result = mergeSubscriptionProviderSections(
      {
        'proxy-providers': {
          existing: { type: 'http', url: 'https://old.test/sub' },
        },
        'proxy-groups': [
          { name: 'select', type: 'select', proxies: ['DIRECT'] },
          { name: 'fallback', type: 'fallback', proxies: ['DIRECT'] },
        ],
      },
      { name: 'Remote', url: 'https://example.test/sub' },
    )

    expect(result['proxy-providers']).toEqual({
      existing: { type: 'http', url: 'https://old.test/sub' },
      Remote: {
        type: 'http',
        url: 'https://example.test/sub',
        interval: 21_600,
        'health-check': {
          enable: true,
          url: 'https://www.gstatic.com/generate_204',
          interval: 600,
          lazy: true,
        },
        override: { 'additional-prefix': '[Remote] ' },
      },
    })
    expect(result['proxy-groups']).toEqual([
      { name: 'select', type: 'select', proxies: ['DIRECT'], use: ['Remote'] },
      { name: 'fallback', type: 'fallback', proxies: ['DIRECT'] },
    ])
  })

  it('handles empty sections and reuses a provider with the same URL', () => {
    const initial: ConfigObject = {
      'proxy-providers': {
        renamed: { type: 'http', url: 'https://example.test/sub' },
      },
      'proxy-groups': [{ name: 'select', type: 'select', use: ['renamed'] }],
    }
    const result = mergeSubscriptionProviderSections(initial, {
      name: 'Other name',
      url: 'https://example.test/sub',
    })

    expect(Object.keys(result['proxy-providers'] as ConfigObject)).toEqual([
      'renamed',
    ])
    expect(result['proxy-groups']).toEqual([
      { name: 'select', type: 'select', use: ['renamed'] },
    ])
  })

  it('returns both sections when the active profile data is empty', () => {
    const result = mergeSubscriptionProviderSections(null, {
      name: 'Remote',
      url: 'https://example.test/sub',
    })

    expect(Object.keys(result['proxy-providers'] as ConfigObject)).toEqual([
      'Remote',
    ])
    expect(result['proxy-groups']).toEqual([])
  })
})
