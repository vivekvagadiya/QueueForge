import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { API_BASE_URL, tokenStore } from '../api/client.js'
import { useAuth } from '../auth/AuthContext.jsx'

// Outside a provider (e.g. component tests), real-time is simply off.
const RealtimeContext = createContext({ status: 'off', subscribe: () => () => {} })

/**
 * Socket.IO server origin: the API's origin when VITE_API_BASE_URL is an
 * absolute URL, otherwise this page's origin (the Vite dev server proxies
 * /socket.io to the API).
 */
const socketOrigin = () => (/^https?:\/\//i.test(API_BASE_URL) ? new URL(API_BASE_URL).origin : undefined)

/**
 * Live updates while signed in. Socket.IO is only an enhancement: the server
 * sends invalidation hints (`{ type: 'job' | 'queue' | 'worker', id, ... }`),
 * and subscribers reload from the API. After a reconnect, or when the server
 * says 'resync', every subscriber reloads, because events may have been missed.
 *
 * status: 'off' | 'connecting' | 'live' | 'reconnecting'
 */
export function RealtimeProvider({ children }) {
  const { status: authStatus } = useAuth()
  const [socketStatus, setSocketStatus] = useState('connecting')
  const subscribers = useRef(new Set())
  const status = authStatus === 'authenticated' ? socketStatus : 'off'
  const setStatus = setSocketStatus

  useEffect(() => {
    if (authStatus !== 'authenticated') return undefined

    const notify = (message) => {
      for (const fn of subscribers.current) fn(message)
    }
    let connectedBefore = false
    const socket = io(socketOrigin(), {
      path: '/socket.io',
      // Read the token on every (re)connect attempt, in case it changed.
      auth: (cb) => cb({ token: tokenStore.get() }),
      reconnectionDelayMax: 10_000,
    })

    socket.on('connect', () => {
      setStatus('live')
      if (connectedBefore) notify({ resync: true })
      connectedBefore = true
    })
    socket.on('disconnect', (reason) => {
      // 'io server disconnect' (e.g. token expired) is not retried automatically.
      setStatus(reason === 'io server disconnect' ? 'off' : 'reconnecting')
    })
    socket.on('connect_error', (err) => {
      // A rejected handshake is not retried by Socket.IO. The session itself
      // is handled by the REST API (its next 401 signs the user out).
      if (err?.message === 'UNAUTHORIZED') setStatus('off')
      else setStatus(connectedBefore ? 'reconnecting' : 'connecting')
    })
    socket.on('events', (events) => notify({ events }))
    socket.on('resync', () => notify({ resync: true }))

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      setStatus('connecting') // initial state for the next session
    }
  }, [authStatus, setStatus])

  const subscribe = useCallback((fn) => {
    subscribers.current.add(fn)
    return () => subscribers.current.delete(fn)
  }, [])
  const value = useMemo(() => ({ status, subscribe }), [status, subscribe])
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useRealtime() {
  return useContext(RealtimeContext)
}
