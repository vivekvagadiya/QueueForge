import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

/**
 * Loads data for the request identified by `key` (any string that changes when
 * the request should change). `fetcher(signal)` returns the API body.
 *
 * Returns { data, meta, error, loading, receivedAt, reload, refresh, setData }:
 * - `loading` is true while the result belongs to a different key; the
 *   previous data stays available so pages can dim it instead of blanking.
 * - `reload()` refetches and shows loading (user-initiated Refresh / Retry).
 * - `refresh()` refetches silently and swaps the data in when it arrives
 *   (live updates); failures keep the current data.
 * - `setData(fn)` patches the current data with persisted state returned by
 *   an action (e.g. the job returned by cancel).
 * - `onResult(body)` may return false to drop a result (e.g. after redirecting).
 */
export function useApiQuery(key, fetcher, { onResult } = {}) {
  const [reloadKey, setReloadKey] = useState(0)
  const fullKey = `${key}#${reloadKey}`
  const [state, setState] = useState({ key: null, data: null, meta: null, error: null, receivedAt: null })

  const run = useEffectEvent((signal) => fetcher(signal))
  const accept = useEffectEvent((body) => (onResult ? onResult(body) !== false : true))

  useEffect(() => {
    const controller = new AbortController()
    run(controller.signal)
      .then((body) => {
        if (accept(body)) {
          setState({ key: fullKey, data: body.data, meta: body.meta ?? null, error: null, receivedAt: Date.now() })
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setState({ key: fullKey, data: null, meta: null, error, receivedAt: Date.now() })
        }
      })
    return () => controller.abort()
  }, [fullKey])

  // Latest fetcher/key for refresh(), which runs outside the effect.
  const latest = useRef({ fetcher, onResult, fullKey })
  useEffect(() => {
    latest.current = { fetcher, onResult, fullKey }
  })
  const refreshController = useRef(null)
  useEffect(() => () => refreshController.current?.abort(), [])

  const refresh = useCallback(() => {
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    const { fetcher: fetchNow, onResult: check, fullKey: keyAtStart } = latest.current
    fetchNow(controller.signal)
      .then((body) => {
        if (check && check(body) === false) return
        // Apply only if the page still shows the same request.
        setState((s) =>
          s.key === keyAtStart
            ? { key: s.key, data: body.data, meta: body.meta ?? null, error: null, receivedAt: Date.now() }
            : s
        )
      })
      .catch(() => {
        /* keep current data; the next event, resync or manual refresh retries */
      })
  }, [])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const setData = useCallback((fn) => setState((s) => ({ ...s, data: fn(s.data) })), [])
  const loading = state.key !== fullKey

  return {
    data: state.data,
    meta: state.meta,
    error: loading ? null : state.error,
    loading,
    receivedAt: state.receivedAt,
    reload,
    refresh,
    setData,
  }
}
