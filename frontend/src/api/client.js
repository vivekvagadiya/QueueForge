/**
 * Thin fetch wrapper for the QueueForge API.
 *
 * - Attaches the stored JWT as `Authorization: Bearer <token>`.
 * - Normalizes every failure into an ApiError carrying the API's
 *   `{ code, message, details }` (network failures get code NETWORK_ERROR).
 * - On a 401 for an authenticated request, clears the token and notifies the
 *   registered handler (AuthContext), which sends the user to the login page.
 */

const rawApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
if (!rawApiBaseUrl) {
  throw new Error('Missing required environment variable: VITE_API_BASE_URL')
}

export const API_BASE_URL = rawApiBaseUrl

const TOKEN_KEY = 'queueforge.accessToken'

// localStorage can throw (private mode, blocked storage); fall back to memory.
let memoryToken = null
export const tokenStore = {
  get() {
    try {
      return window.localStorage.getItem(TOKEN_KEY) ?? memoryToken
    } catch {
      return memoryToken
    }
  },
  set(token) {
    memoryToken = token
    try {
      window.localStorage.setItem(TOKEN_KEY, token)
    } catch {
      /* memory only */
    }
  },
  clear() {
    memoryToken = null
    try {
      window.localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* nothing stored */
    }
  },
}

export class ApiError extends Error {
  constructor({ status, code, message, details = null }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /** Validation details as `{ fieldPath: message }` (first message per field). */
  fieldErrors() {
    const out = {}
    for (const d of Array.isArray(this.details) ? this.details : []) {
      if (d?.path && !(d.path in out)) out[d.path] = d.message
    }
    return out
  }
}

let unauthorizedHandler = null

/** Registers the 401 handler; returns an unsubscribe function. */
export const onUnauthorized = (handler) => {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null
  }
}

const buildQuery = (query) => {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Performs a request and returns the parsed body (`{ success, data, meta? }`).
 * Throws ApiError on any non-2xx response or network failure.
 */
export async function apiRequest(path, { method = 'GET', body, query, auth = true, signal, headers = {} } = {}) {
  const token = auth ? tokenStore.get() : null
  const init = {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }

  let res
  try {
    res = await fetch(`${API_BASE_URL}${path}${buildQuery(query)}`, init)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the QueueForge API. Is it running?' })
  }

  let payload = null
  try {
    payload = await res.json()
  } catch {
    /* empty or non-JSON body */
  }

  if (!res.ok) {
    const error = new ApiError({
      status: res.status,
      code: payload?.error?.code ?? `HTTP_${res.status}`,
      message: payload?.error?.message ?? `Request failed (${res.status})`,
      details: payload?.error?.details ?? null,
    })
    if (res.status === 401 && token) {
      tokenStore.clear()
      unauthorizedHandler?.(error)
    }
    throw error
  }

  return payload
}
