import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'pages')

function listVueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listVueFiles(path)
    return entry.isFile() && entry.name.endsWith('.vue') ? [path] : []
  })
}

function parentPagesWithChildren(): string[] {
  return listVueFiles(pagesDir).filter((file) => {
    const siblingDirectory = join(dirname(file), basename(file, '.vue'))
    try {
      return listVueFiles(siblingDirectory).length > 0
    } catch {
      return false
    }
  })
}

describe('nuxt page route outlets', () => {
  it('every parent page with nested child routes renders NuxtPage', () => {
    const missing = parentPagesWithChildren().filter(
      (file) => !readFileSync(file, 'utf8').includes('<NuxtPage'),
    )

    expect(missing.map((file) => relative(pagesDir, file))).toEqual([])
  })

  it('renders the profiles list and nested editor exclusively by route', () => {
    const source = readFileSync(join(pagesDir, 'profiles.vue'), 'utf8')

    expect(source).toMatch(
      /const\s+isEditRoute\s*=\s*computed\(\(\)\s*=>\s*route\.name\s*===\s*['"]profiles-id-edit['"]\s*\)/,
    )
    expect(source).toMatch(/<template\s+v-if="!isEditRoute">/)
    expect(source).toMatch(/<NuxtPage\s+v-else\s*\/>/)
  })

  it('has a dedicated node-check route page', () => {
    expect(readFileSync(join(pagesDir, 'node-check.vue'), 'utf8')).toContain(
      'useNodeCheck()',
    )
  })
})
