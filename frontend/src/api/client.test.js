import { describe, expect, test, vi } from 'vitest'
import { fail, mockApi, ok } from '../test/mockApi.js'
import { ApiError, apiRequest, onUnauthorized, tokenStore } from './client.js'

describe('apiRequest', () => {
  test('attaches the bearer token and drops empty query values', async () => {
    const fetchMock = mockApi({ 'GET /queues': () => ok([]) })
    tokenStore.set('tok-123')

    await apiRequest('/queues', { query: { page: 2, status: ['ACTIVE', 'PAUSED'], search: '', x: undefined } })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/queues?page=2&status=ACTIVE%2CPAUSED')
    expect(init.headers.Authorization).toBe('Bearer tok-123')
  })

  test('auth: false requests never send the token', async () => {
    const fetchMock = mockApi({ 'POST /auth/login': () => ok({}) })
    tokenStore.set('tok-123')
    await apiRequest('/auth/login', { method: 'POST', body: {}, auth: false })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  test('turns API errors into ApiError with code, message and field errors', async () => {
    mockApi({
      'POST /queues': () =>
        fail(400, 'VALIDATION_ERROR', 'Request validation failed', [
          { path: 'name', message: 'Bad name' },
          { path: 'name', message: 'second message ignored' },
          { path: 'concurrency', message: 'Too small' },
        ]),
    })
    const err = await apiRequest('/queues', { method: 'POST', body: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.fieldErrors()).toEqual({ name: 'Bad name', concurrency: 'Too small' })
  })

  test('a 401 on an authenticated request clears the token and notifies the handler', async () => {
    mockApi({ 'GET /auth/me': () => fail(401, 'TOKEN_EXPIRED', 'Access token has expired') })
    tokenStore.set('expired')
    const handler = vi.fn()
    const unsubscribe = onUnauthorized(handler)

    await expect(apiRequest('/auth/me')).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' })
    expect(tokenStore.get()).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
    unsubscribe()
  })

  test('a 401 from login (no token) does not trigger the session handler', async () => {
    mockApi({ 'POST /auth/login': () => fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password') })
    const handler = vi.fn()
    const unsubscribe = onUnauthorized(handler)
    await expect(apiRequest('/auth/login', { method: 'POST', body: {}, auth: false })).rejects.toThrow(
      'Invalid email or password'
    )
    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })

  test('network failures become NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(apiRequest('/queues')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' })
  })
})
