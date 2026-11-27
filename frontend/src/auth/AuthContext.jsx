import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { onUnauthorized, tokenStore } from '../api/client.js'
import { authApi } from '../api/endpoints.js'

const AuthContext = createContext(null)

/**
 * Session state. The JWT lives in localStorage (see tokenStore); on load the
 * user is restored with GET /auth/me, so a refresh keeps the session as long
 * as the token is valid. Any 401 from the API ends the session.
 *
 * status: 'loading' | 'authenticated' | 'anonymous'
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState(() => ({
    status: tokenStore.get() ? 'loading' : 'anonymous',
    user: null,
    sessionExpired: false,
  }))

  useEffect(() => {
    if (state.status !== 'loading') return undefined
    const controller = new AbortController()
    authApi
      .me({ signal: controller.signal })
      .then((res) => setState({ status: 'authenticated', user: res.data, sessionExpired: false }))
      .catch((err) => {
        if (err?.name === 'AbortError') return
        // A 401 already cleared the token. For other failures (API down), keep
        // the token but treat the user as signed out until they retry.
        setState({ status: 'anonymous', user: null, sessionExpired: err?.status === 401 })
      })
    return () => controller.abort()
  }, [state.status])

  useEffect(
    () =>
      onUnauthorized(() => {
        setState({ status: 'anonymous', user: null, sessionExpired: true })
      }),
    []
  )

  const startSession = useCallback(({ user, accessToken }) => {
    tokenStore.set(accessToken)
    setState({ status: 'authenticated', user, sessionExpired: false })
  }, [])

  const login = useCallback(async (credentials) => startSession((await authApi.login(credentials)).data), [startSession])
  const register = useCallback(async (input) => startSession((await authApi.register(input)).data), [startSession])

  const logout = useCallback(() => {
    tokenStore.clear()
    setState({ status: 'anonymous', user: null, sessionExpired: false })
  }, [])

  const value = useMemo(() => ({ ...state, login, register, logout }), [state, login, register, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
