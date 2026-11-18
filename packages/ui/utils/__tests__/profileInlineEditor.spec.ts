import { openDocument } from '@metacubexd/config-editor'
import { describe, expect, it } from 'vitest'
import { insertSubscriptionProviderYaml } from '../profileInlineEditor'

describe('insertSubscriptionProviderYaml', () => {
  it('inserts a provider into empty YAML', () => {
    const result = insertSubscriptionProviderYaml('', {
      name: 'Remote',
      url: 'https://example.test/sub',
    })

    expect(openDocument(result).data['proxy-providers']).toEqual({
      Remote: expect.objectContaining({
        type: 'http',
        url: 'https://example.test/sub',
      }),
    })
  })

  it('preserves existing YAML while adding the provider', () => {
    const result = insertSubscriptionProviderYaml(
      '# keep me\nmode: rule\nproxy-groups:\n  - name: Choose\n    type: select\n',
      { name: 'Remote', url: 'https://example.test/sub' },
    )

    expect(result).toContain('# keep me')
    expect(openDocument(result).data['proxy-groups']).toEqual([
      { name: 'Choose', type: 'select', use: ['Remote'] },
    ])
  })
})
