import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import { useRealtime } from '../realtime/RealtimeProvider.jsx'

const LIVE_LABELS = {
  live: ['Live', 'Updates appear automatically.'],
  connecting: ['Connecting…', 'Connecting for live updates.'],
  reconnecting: ['Reconnecting…', 'Live updates paused; data reloads when the connection returns.'],
  off: ['Live updates off', 'Use Refresh to load the latest data.'],
}

/** Real-time connection state. Pages always work without it (Refresh / reload). */
function LiveIndicator() {
  const { status } = useRealtime()
  const [label, help] = LIVE_LABELS[status] ?? LIVE_LABELS.off
  return (
    <span className={`live-indicator live-${status}`} title={help} role="status">
      <span className="live-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

const NAV = [
  { to: '/queues', label: 'Queues' },
  { to: '/workers', label: 'Workers' },
]

/** Authenticated app shell: sidebar navigation, header with the user and logout. */
export function Layout() {
  const { user, logout } = useAuth()
  const [navOpen, setNavOpen] = useState(false)

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            QF
          </span>
          <span>QueueForge</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              onClick={() => setNavOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button nav-toggle"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            ☰
          </button>
          <LiveIndicator />
          <div className="topbar-user">
            <span className="user-name" title={user?.email}>
              {user?.name}
            </span>
            <button type="button" className="button button-ghost" onClick={logout}>
              Log out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
