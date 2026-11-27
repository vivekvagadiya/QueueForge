/* eslint-disable react-refresh/only-export-components -- test helper, not a hot-reloaded module */
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { AppRoutes } from '../App.jsx'
import { AuthProvider } from '../auth/AuthContext.jsx'
import { ToastProvider } from '../components/Toasts.jsx'

function LocationProbe({ onChange }) {
  const location = useLocation()
  useEffect(() => onChange(location), [location, onChange])
  return null
}

/** Renders the real routes at `path`; `location()` returns the router's current location. */
export function renderApp(path = '/') {
  const user = userEvent.setup()
  let current = null
  const track = (location) => {
    current = location
  }
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
          <LocationProbe onChange={track} />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>
  )
  return { user, ...utils, location: () => current }
}
