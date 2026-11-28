import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import { useRealtime } from '../realtime/RealtimeProvider.jsx'
import { useTheme } from '../theme/ThemeContext.jsx'

const LIVE_LABELS = {
  live: ['Live', 'Real-time updates connected.'],
  connecting: ['Connecting…', 'Connecting for live updates.'],
  reconnecting: ['Reconnecting…', 'Live updates paused; data reloads when the connection returns.'],
  off: ['Offline', 'Live updates off. Use Refresh to load the latest data.'],
}

/** Real-time connection state pill. Pages always work without it (Refresh / reload). */
function LiveIndicator() {
  const { status } = useRealtime()
  const [label, help] = LIVE_LABELS[status] ?? LIVE_LABELS.off
  return (
    <span className={`live-indicator live-${status}`} title={help} role="status">
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">{label}</span>
    </span>
  )
}

function OverviewIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  )
}

function HealthIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function QueuesIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </svg>
  )
}

function WorkersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="7" rx="2" />
      <rect x="2" y="14" width="20" height="7" rx="2" />
      <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
      <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function CollapseIcon({ collapsed }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? <polyline points="9 18 15 12 9 6" /> : <polyline points="15 18 9 12 15 6" />}
    </svg>
  )
}

function ThemeToggle() {
  const { resolvedTheme, toggleTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme'

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

const NAV = [
  { to: '/', label: 'Overview', Icon: OverviewIcon, end: true },
  { to: '/queues', label: 'Queues', Icon: QueuesIcon },
  { to: '/workers', label: 'Workers', Icon: WorkersIcon },
  { to: '/health', label: 'System Health', Icon: HealthIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

function getPageTitle(pathname) {
  if (pathname === '/') return 'Overview'
  if (pathname.startsWith('/queues/') && pathname.endsWith('/jobs')) return 'Jobs'
  if (pathname.startsWith('/jobs/')) return 'Job Detail'
  if (pathname.startsWith('/workers')) return 'Workers'
  if (pathname.startsWith('/queues')) return 'Queues'
  if (pathname.startsWith('/health')) return 'System Health'
  if (pathname.startsWith('/settings')) return 'Settings'
  return 'QueueForge'
}

/** Authenticated app shell: collapsible sidebar navigation, header with status, theme toggle, and user logout. */
export function Layout() {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  const pageTitle = getPageTitle(pathname)

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
      {navOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      )}

      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              QF
            </span>
            <span className="brand-name">QueueForge</span>
          </div>
          <button
            type="button"
            className="sidebar-collapse-btn"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <CollapseIcon collapsed={collapsed} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              onClick={() => setNavOpen(false)}
            >
              <span className="nav-icon">
                <item.Icon />
              </span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-identity">
            <span className="sidebar-identity-title">QueueForge</span>
            <span className="sidebar-identity-sub">Job Queue Control Plane</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="icon-button nav-toggle"
              aria-label="Toggle navigation"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((o) => !o)}
            >
              ☰
            </button>
            <span className="topbar-title">{pageTitle}</span>
          </div>

          <div className="topbar-right">
            <LiveIndicator />
            <ThemeToggle />
            <div className="topbar-user">
              <span className="user-name" title={user?.email}>
                {user?.name}
              </span>
              <button type="button" className="button button-ghost button-small" onClick={logout}>
                Log out
              </button>
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
