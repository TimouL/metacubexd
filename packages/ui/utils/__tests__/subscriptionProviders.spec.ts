import type { ProfileMeta } from '~/types/control'
import { describe, expect, it } from 'vitest'
import {
  formatSubscriptionUsage,
  manualProviderName,
  subscriptionChoices,
  validSubscriptionUrl,
} from '../subscriptionProviders'

function profile(overrides: Partial<ProfileMeta>): ProfileMeta {
  return {
    id: 'id',
    name: 'Local',
    type: 'local',
    updatedAt: 1,
    ...overrides,
  }
}

describe('subscription provider helpers', () => {
  it('keeps only remote profiles with usable HTTP URLs', () => {
    const choices = subscriptionChoices([
      profile({
        id: 'remote',
        name: 'Remote',
        type: 'remote',
        url: 'https://example.test/sub',
      }),
      profile({ id: 'local', name: 'Local' }),
      profile({ id: 'bad', type: 'remote', url: 'ftp://example.test/sub' }),
    ])

    expect(choices).toEqual([
      {
        id: 'remote',
        name: 'Remote',
        url: 'https://example.test/sub',
        subscriptionInfo: undefined,
      },
    ])
  })

  it('preserves traffic and expiry metadata for display', () => {
    const subscriptionInfo = {
      upload: 1,
      download: 2,
      total: 3,
      expire: 4,
    }
    const choices = subscriptionChoices([
      profile({
        type: 'remote',
        url: 'https://example.test/sub',
        subscriptionInfo,
      }),
    ])

    expect(choices[0]?.subscriptionInfo).toEqual(subscriptionInfo)
    expect(formatSubscriptionUsage(subscriptionInfo)).toBe(
      '3 B / 3 B · 1970-01-01',
    )
  })

  it('omits an absent expiry from the usage summary', () => {
    expect(
      formatSubscriptionUsage({
        upload: 1,
        download: 2,
        total: 3,
        expire: 0,
      }),
    ).toBe('3 B / 3 B')
  })

  it.each([
    ['https://example.test/sub', true],
    ['http://example.test/sub', true],
    ['  https://example.test/sub  ', true],
    ['ftp://example.test/sub', false],
    ['example.test/sub', false],
    ['', false],
  ])('validates %s as %s', (url, expected) => {
    expect(validSubscriptionUrl(url)).toBe(expected)
  })

  it.each([
    ['https://www.example.co.jp/path?token=1', 'example.co.jp'],
    ['http://localhost:8080/sub', 'localhost'],
    ['https://192.168.1.2/sub', '192.168.1.2'],
  ])('derives a safe provider name from %s', (url, expected) => {
    expect(manualProviderName(url)).toBe(expected)
  })
})
