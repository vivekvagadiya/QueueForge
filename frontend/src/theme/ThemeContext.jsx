import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'queueforge-theme'
const VALID_THEMES = new Set(['dark', 'light', 'system'])

function getSystemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function readStoredTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return VALID_THEMES.has(saved) ? saved : 'dark'
  } catch {
    return 'dark'
  }
}

function resolveThemeValue(pref) {
  return pref === 'system' ? getSystemTheme() : pref
}

const ThemeContext = createContext({
  theme: 'dark',
  resolvedTheme: 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
})

/**
 * Manages Dark / Light / System theme preference with localStorage persistence
 * and `data-theme` attribute synchronization on `<html>`.
 */
export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme)
  const [systemTheme, setSystemTheme] = useState(getSystemTheme)

  const resolvedTheme = theme === 'system' ? systemTheme : theme

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystemTheme(media.matches ? 'light' : 'dark')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((next) => {
    const normalized = VALID_THEMES.has(next) ? next : 'dark'
    setThemeState(normalized)
    try {
      localStorage.setItem(STORAGE_KEY, normalized)
    } catch {
      // Ignore storage errors (e.g. private browsing restrictions).
    }
  }, [])

  const toggleTheme = useCallback(() => {
    const current = resolveThemeValue(theme)
    setTheme(current === 'dark' ? 'light' : 'dark')
  }, [theme, setTheme])

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  return useContext(ThemeContext)
}
