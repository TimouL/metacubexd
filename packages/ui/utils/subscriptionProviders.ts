import type { ProfileMeta, ProfileSubscriptionInfo } from '~/types/control'
import byteSize from 'byte-size'
import dayjs from 'dayjs'

const MULTIPART_SUFFIXES = new Set(['co.jp', 'com.au', 'co.uk', 'com.cn'])

export interface SubscriptionProviderChoice {
  id: string
  name: string
  url: string
  subscriptionInfo?: ProfileSubscriptionInfo
}

export interface SubscriptionProviderSelection {
  name: string
  url: string
}

export function validSubscriptionUrl(value: string): boolean {
  const url = value.trim()
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function manualProviderName(url: string): string {
  const parsed = new URL(url.trim())
  const hostname = parsed.hostname
  const labels = hostname.split('.')
  if (labels.length > 2 && !isIpAddress(hostname)) {
    const lastTwo = labels.slice(-2).join('.')
    const suffix = MULTIPART_SUFFIXES.has(lastTwo)
      ? labels.slice(-3).join('.')
      : lastTwo
    return suffix
  }
  return hostname
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
}

export function subscriptionChoices(
  profiles: ProfileMeta[],
): SubscriptionProviderChoice[] {
  return profiles.flatMap((profile) => {
    if (profile.type !== 'remote' || !validSubscriptionUrl(profile.url ?? ''))
      return []
    return [
      {
        id: profile.id,
        name: profile.name,
        url: (profile.url ?? '').trim(),
        ...(profile.subscriptionInfo
          ? { subscriptionInfo: profile.subscriptionInfo }
          : {}),
      },
    ]
  })
}

export function formatSubscriptionUsage(info: ProfileSubscriptionInfo): string {
  const used = info.download + info.upload
  const usedText = byteSize(used, { units: 'iec' }).toString()
  const totalText = byteSize(info.total, { units: 'iec' }).toString()
  const expiryText = info.expire
    ? dayjs(info.expire * 1000).format('YYYY-MM-DD')
    : ''
  return expiryText
    ? `${usedText} / ${totalText} · ${expiryText}`
    : `${usedText} / ${totalText}`
}
