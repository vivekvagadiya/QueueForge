import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Page state kept in the URL query string, so a refresh or shared link
 * restores the same view. `update({ key: value })` removes empty values and
 * page=1 (the default), and replaces the history entry.
 */
export function useUrlParams() {
  const [params, setParams] = useSearchParams()
  const update = useCallback(
    (changes) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(changes)) {
            if (value === '' || value === null || value === undefined || (key === 'page' && value === 1)) next.delete(key)
            else next.set(key, String(value))
          }
          return next
        },
        { replace: true }
      ),
    [setParams]
  )
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  return { params, page, update }
}

/**
 * Text input bound to a URL value with a debounce. Returns [input, setInput].
 * When the URL value changes from elsewhere (back/forward, clear filters) the
 * input follows it; the sync happens during render rather than in an effect.
 */
export function useDebouncedUrlValue(urlValue, commit, delayMs = 300) {
  const [input, setInput] = useState(urlValue)
  const [synced, setSynced] = useState(urlValue)
  const timer = useRef(null)

  if (urlValue !== synced) {
    setSynced(urlValue)
    setInput(urlValue)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  const onChange = (value) => {
    setInput(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (value.trim() !== urlValue) commit(value.trim())
    }, delayMs)
  }
  return [input, onChange]
}
