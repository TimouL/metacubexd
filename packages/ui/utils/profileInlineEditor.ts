import type { SubscriptionProviderSelection } from '~/utils/subscriptionProviders'
import { addSubscriptionProxyProvider } from '@metacubexd/config-editor'

export function insertSubscriptionProviderYaml(
  yaml: string,
  selection: SubscriptionProviderSelection,
): string {
  return addSubscriptionProxyProvider(yaml, selection).yaml
}
