import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'queueforge-preferences'

const DEFAULT_PREFERENCES = {
  liveRefreshEnabled: true,
  compactTables: false,
}

function readPreferences() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(raw)
    return {
      liveRefreshEnabled:
        typeof parsed?.liveRefreshEnabled === 'boolean'
          ? parsed.liveRefreshEnabled
          : DEFAULT_PREFERENCES.liveRefreshEnabled,
      compactTables:
        typeof parsed?.compactTables === 'boolean'
          ? parsed.compactTables
          : DEFAULT_PREFERENCES.compactTables,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

const PreferencesContext = createContext({
  ...DEFAULT_PREFERENCES,
  setPreference: () => {},
})

/**
 * Persists functional UI preferences (live auto-refresh and compact table density)
 * in localStorage and syncs `data-compact` on `<html>`.
 */
export function PreferencesProvider({ children }) {
  const [prefs, setPrefs] = useState(readPreferences)

  useEffect(() => {
    if (prefs.compactTables) {
      document.documentElement.setAttribute('data-compact', 'true')
    } else {
      document.documentElement.removeAttribute('data-compact')
    }
  }, [prefs.compactTables])

  const setPreference = useCallback((key, value) => {
    setPrefs((prev) => {
      if (!(key in DEFAULT_PREFERENCES)) return prev
      const next = { ...prev, [key]: Boolean(value) }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Ignore storage errors.
      }
      return next
    })
  }, [])

  const value = useMemo(
    () => ({
      liveRefreshEnabled: prefs.liveRefreshEnabled,
      compactTables: prefs.compactTables,
      setPreference,
    }),
    [prefs.liveRefreshEnabled, prefs.compactTables, setPreference],
  )

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePreferences() {
  return useContext(PreferencesContext)
}
