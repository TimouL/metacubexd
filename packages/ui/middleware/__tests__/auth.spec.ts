import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const navigateTo = vi.fn((path: string) => ({ path }))

vi.stubGlobal('defineNuxtRouteMiddleware', (handler: unknown) => handler)
vi.stubGlobal('navigateTo', navigateTo)
vi.stubGlobal('useRuntimeConfig', () => ({
  public: { mockMode: false },
}))

const currentEndpoint = { id: 'hydrated', url: 'http://localhost:9090' }
let storeCurrentEndpoint: typeof currentEndpoint | null = null
let authMiddleware: (to: { path: string }, from: { path: string }) => unknown

vi.stubGlobal('useEndpointStore', () => ({
  currentEndpoint: storeCurrentEndpoint,
}))

beforeAll(async () => {
  authMiddleware = (await import('../auth.global'))
    .default as typeof authMiddleware
})

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    storeCurrentEndpoint = null
  })

  it('allows navigation when the store has not hydrated but localStorage has a selected endpoint', () => {
    localStorage.setItem('selectedEndpoint', 'saved')
    localStorage.setItem(
      'endpointList',
      JSON.stringify([{ id: 'saved', url: 'http://localhost:9090' }]),
    )

    expect(authMiddleware({ path: '/profiles' }, { path: '/' })).toBeUndefined()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('allows navigation when the hydrated store exposes the current endpoint', () => {
    storeCurrentEndpoint = currentEndpoint

    expect(
      authMiddleware({ path: '/profiles/one/edit' }, { path: '/' }),
    ).toBeUndefined()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('redirects when neither the store nor localStorage has a matching endpoint', () => {
    localStorage.setItem('selectedEndpoint', 'saved')
    localStorage.setItem(
      'endpointList',
      JSON.stringify([{ id: 'other', url: 'http://localhost:9090' }]),
    )

    expect(authMiddleware({ path: '/profiles' }, { path: '/' })).toEqual({
      path: '/',
    })
    expect(navigateTo).toHaveBeenCalledWith('/', { replace: true })
  })

  it('keeps the connect and setup routes exempt', () => {
    for (const path of ['/', '/setup']) {
      expect(authMiddleware({ path }, { path: '/profiles' })).toBeUndefined()
    }
    expect(navigateTo).not.toHaveBeenCalled()
  })
})
