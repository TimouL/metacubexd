import type { ConfigObject, ConfigValue } from '@metacubexd/config-editor'
import type { SubscriptionProviderSelection } from '~/utils/subscriptionProviders'
import {
  addSubscriptionProxyProvider,
  openDocument,
} from '@metacubexd/config-editor'

function isObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeSubscriptionProviderSections(
  data: ConfigObject | null,
  selection: SubscriptionProviderSelection,
): Record<string, ConfigValue> {
  const source: ConfigObject = {
    ...(data ?? {}),
    ...(isObject(data?.['proxy-providers']) ? {} : { 'proxy-providers': {} }),
    ...(Array.isArray(data?.['proxy-groups']) ? {} : { 'proxy-groups': [] }),
  }
  const parsed = openDocument(
    Object.entries(source)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n'),
  )
  const document = addSubscriptionProxyProvider(parsed, selection)
  const providers = document.data['proxy-providers']
  const groups = document.data['proxy-groups']
  return {
    ...(isObject(providers) ? { 'proxy-providers': providers } : {}),
    ...(Array.isArray(groups) ? { 'proxy-groups': groups } : {}),
  }
}
