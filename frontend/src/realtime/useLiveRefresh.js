import { useEffect, useEffectEvent, useRef } from 'react'
import { useRealtime } from './RealtimeProvider.jsx'

/**
 * Calls `refresh()` when a live event matches `match(event)`, or on resync.
 * Calls are debounced (`delayMs`) so a burst of events causes one reload.
 * `refresh` should reload from the API without blanking the page.
 */
export function useLiveRefresh(match, refresh, { delayMs = 300 } = {}) {
  const { subscribe } = useRealtime()
  const timer = useRef(null)
  const matches = useEffectEvent((event) => match(event))
  const run = useEffectEvent(() => refresh())

  useEffect(() => {
    const schedule = () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(run, delayMs)
    }
    const unsubscribe = subscribe((message) => {
      if (message.resync || message.events?.some(matches)) schedule()
    })
    return () => {
      unsubscribe()
      clearTimeout(timer.current)
    }
  }, [subscribe, delayMs])
}
