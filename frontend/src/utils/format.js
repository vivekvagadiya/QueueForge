export const formatDateTime = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

/** Exact timestamp with seconds, for detail views. */
export const formatTimestamp = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—'

/** 950 → "950 ms", 4200 → "4.2 s", 125000 → "2m 5s". */
export const formatDuration = (ms) => {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** An age in ms as "just now", "12s ago", "5m ago", "3h ago", "2d ago". */
export const formatAge = (ms) => {
  if (ms === null || ms === undefined) return 'never'
  if (ms < 2000) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export const shortId = (id) => (id ? id.slice(0, 8) : '—')

export const prettyJson = (value) => JSON.stringify(value, null, 2)
