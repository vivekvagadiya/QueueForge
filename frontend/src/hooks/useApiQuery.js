import { useCallback, useEffect, useEffectEvent, useState } from 'react'

/**
 * Loads data for the request identified by `key` (any string that changes when
 * the request should change). `fetcher(signal)` returns the API body.
 *
 * Returns { data, meta, error, loading, reload, setData }:
 * - `loading` is true while the result belongs to a different key; the
 *   previous data stays available so pages can dim it instead of blanking.
 * - `setData(fn)` patches the current data with persisted state returned by
 *   an action (e.g. the job returned by cancel).
 * - `onResult(body)` may return false to drop a result (e.g. after redirecting).
 */
export function useApiQuery(key, fetcher, { onResult } = {}) {
  const [reloadKey, setReloadKey] = useState(0)
  const fullKey = `${key}#${reloadKey}`
  const [state, setState] = useState({ key: null, data: null, meta: null, error: null })

  const run = useEffectEvent((signal) => fetcher(signal))
  const accept = useEffectEvent((body) => (onResult ? onResult(body) !== false : true))

  useEffect(() => {
    const controller = new AbortController()
    run(controller.signal)
      .then((body) => {
        if (accept(body)) setState({ key: fullKey, data: body.data, meta: body.meta ?? null, error: null })
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') setState({ key: fullKey, data: null, meta: null, error })
      })
    return () => controller.abort()
  }, [fullKey])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const setData = useCallback((fn) => setState((s) => ({ ...s, data: fn(s.data) })), [])
  const loading = state.key !== fullKey

  return { data: state.data, meta: state.meta, error: loading ? null : state.error, loading, reload, setData }
}
