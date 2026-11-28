import { useAuth } from '../auth/AuthContext.jsx'
import { usePreferences } from '../theme/PreferencesContext.jsx'
import { useTheme } from '../theme/ThemeContext.jsx'

const THEME_OPTIONS = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'High-contrast dark surface palette optimized for long operational sessions.',
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Clean, bright surface palette for well-lit environments.',
  },
  {
    value: 'system',
    label: 'System',
    description: 'Automatically matches your operating system color scheme preference.',
  },
]

export function SettingsPage() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const { liveRefreshEnabled, compactTables, setPreference } = usePreferences()
  const { user, logout } = useAuth()

  return (
    <section className="settings-page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">Appearance and dashboard preferences stored locally in your browser.</p>
        </div>
      </div>

      <div className="settings-stack">
        <section className="card">
          <h2>Appearance</h2>
          <p className="muted">
            Choose your preferred theme. Currently rendering <strong className="mono">{resolvedTheme}</strong> mode.
          </p>
          <div className="theme-options-grid" role="radiogroup" aria-label="Theme preference">
            {THEME_OPTIONS.map((opt) => {
              const selected = theme === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`theme-option-card${selected ? ' active' : ''}`}
                  onClick={() => setTheme(opt.value)}
                >
                  <div className="theme-option-head">
                    <span className="theme-option-title">{opt.label}</span>
                    {selected && <span className="badge badge-active">Active</span>}
                  </div>
                  <p className="theme-option-desc">{opt.description}</p>
                </button>
              )
            })}
          </div>
        </section>

        <section className="card">
          <h2>Application Preferences</h2>
          <p className="muted">Control how the dashboard behaves while you monitor queues and jobs.</p>

          <div className="pref-list">
            <label className="pref-row" htmlFor="pref-live-refresh">
              <div>
                <div className="pref-title">Live auto-refresh</div>
                <div className="cell-sub">
                  Automatically reload open views when Socket.IO receives queue, job, or worker updates.
                </div>
              </div>
              <input
                id="pref-live-refresh"
                type="checkbox"
                className="pref-checkbox"
                checked={liveRefreshEnabled}
                onChange={(e) => setPreference('liveRefreshEnabled', e.target.checked)}
              />
            </label>

            <label className="pref-row" htmlFor="pref-compact-tables">
              <div>
                <div className="pref-title">Compact table density</div>
                <div className="cell-sub">
                  Reduce vertical padding in queue, job, and worker tables to fit more rows on screen.
                </div>
              </div>
              <input
                id="pref-compact-tables"
                type="checkbox"
                className="pref-checkbox"
                checked={compactTables}
                onChange={(e) => setPreference('compactTables', e.target.checked)}
              />
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Session</h2>
          <p className="muted">Authenticated account for this browser session.</p>
          <dl className="details settings-session-details">
            <div className="detail">
              <dt>Name</dt>
              <dd>{user?.name ?? '—'}</dd>
            </div>
            <div className="detail">
              <dt>Email</dt>
              <dd className="mono">{user?.email ?? '—'}</dd>
            </div>
          </dl>
          <div className="settings-session-actions">
            <button type="button" className="button button-danger" onClick={logout}>
              Log out
            </button>
          </div>
        </section>
      </div>
    </section>
  )
}
