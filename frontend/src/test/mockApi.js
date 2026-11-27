import { vi } from 'vitest'

/**
 * Replaces global fetch with a router over `handlers`:
 *   { 'GET /queues': (req) => [status, body] | body, ... }
 * Paths are matched without the /api/v1 prefix and query string; the handler
 * receives { method, path, query: URLSearchParams, body, headers }.
 * Returns the vi.fn so tests can inspect calls.
 */
export function mockApi(handlers) {
  const fn = vi.fn(async (url, init = {}) => {
    const u = new URL(url, 'http://localhost')
    const path = u.pathname.replace(/^\/api\/v1/, '')
    const method = init.method ?? 'GET'
    const key = Object.keys(handlers).find((k) => {
      const [m, pattern] = k.split(' ')
      if (m !== method) return false
      const re = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`)
      return re.test(path)
    })
    if (!key) throw new Error(`Unhandled request ${method} ${path}`)
    const req = {
      method,
      path,
      query: u.searchParams,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    }
    let out = await handlers[key](req)
    if (!Array.isArray(out)) out = [200, out]
    const [status, body] = out
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

export const ok = (data, meta) => ({ success: true, data, ...(meta ? { meta } : {}) })
export const fail = (status, code, message, details) => [
  status,
  { success: false, error: { code, message, ...(details ? { details } : {}) } },
]

export const queueFixture = (overrides = {}) => ({
  id: crypto.randomUUID(),
  name: 'emails',
  description: null,
  status: 'ACTIVE',
  concurrency: 2,
  defaultJobOptions: {},
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  ...overrides,
})
