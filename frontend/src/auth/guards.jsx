import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Spinner } from '../components/ui.jsx'
import { useAuth } from './AuthContext.jsx'

/** Signed-in users only; others go to /login and come back afterwards. */
export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <Spinner label="Restoring session…" />
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: location }} />
  return <Outlet />
}

/** Login/register: signed-in users are sent on to the app. */
export function PublicOnly() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <Spinner label="Restoring session…" />
  if (status === 'authenticated') {
    const from = location.state?.from
    return <Navigate to={from ? `${from.pathname}${from.search ?? ''}` : '/queues'} replace />
  }
  return <Outlet />
}
