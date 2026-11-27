import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { queuesApi } from '../api/endpoints.js'
import { useToast } from '../components/Toasts.jsx'
import { EmptyState, ErrorState, Pagination, Spinner, StatusBadge } from '../components/ui.jsx'
import { useLiveRefresh } from '../realtime/useLiveRefresh.js'
import { formatDateTime } from '../utils/format.js'
import { QueueFormModal } from './QueueFormModal.jsx'

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 300
const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'ARCHIVED', label: 'Archived' },
]

/**
 * Search, status filter and page live in the URL, so a refresh or a shared
 * link shows the same view, reloaded from the API (the source of truth).
 */
export function QueuesPage() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const search = params.get('search') ?? ''
  const status = params.get('status') ?? ''
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)

  const [searchInput, setSearchInput] = useState(search)
  const [syncedSearch, setSyncedSearch] = useState(search)
  // `key` identifies the request a result belongs to; while it differs from
  // the current request, the page is loading (previous rows stay visible, dimmed).
  const [result, setResult] = useState({ key: null, error: null, data: [], meta: null })
  const [reloadKey, setReloadKey] = useState(0)
  const requestKey = JSON.stringify([page, status, search, reloadKey])
  const [modal, setModal] = useState(null) // null | { queue?: object }
  const [busyId, setBusyId] = useState(null)

  const updateParams = useCallback(
    (changes) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(changes)) {
            if (value === '' || value === null || value === undefined || (key === 'page' && value === 1)) next.delete(key)
            else next.set(key, String(value))
          }
          return next
        },
        { replace: true }
      ),
    [setParams]
  )

  // When the URL's search changes from outside the input (back/forward, clear
  // filters), show it in the input. Adjusted during render, not in an effect.
  if (search !== syncedSearch) {
    setSyncedSearch(search)
    setSearchInput(search)
  }

  // Push typed text to the URL after a pause.
  useEffect(() => {
    if (searchInput.trim() === search) return undefined
    const timer = setTimeout(() => updateParams({ search: searchInput.trim(), page: 1 }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, search, updateParams])

  useEffect(() => {
    const controller = new AbortController()
    queuesApi
      .list({ page, limit: PAGE_SIZE, status, search }, { signal: controller.signal })
      .then((res) => {
        // A page past the end (e.g. after filtering) jumps to the last page.
        if (res.meta.totalPages > 0 && page > res.meta.totalPages) {
          updateParams({ page: res.meta.totalPages })
          return
        }
        setResult({ key: requestKey, error: null, data: res.data, meta: res.meta })
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setResult({ key: requestKey, error: err, data: [], meta: null })
      })
    return () => controller.abort()
  }, [page, status, search, requestKey, updateParams])

  const reload = () => setReloadKey((k) => k + 1)

  // Live updates: any change to one of the user's queues reloads the current
  // view quietly (no dimming); the result is applied only if the view is unchanged.
  const refreshQuietly = () => {
    const key = requestKey
    queuesApi
      .list({ page, limit: PAGE_SIZE, status, search })
      .then((res) => setResult((r) => (r.key === key ? { key, error: null, data: res.data, meta: res.meta } : r)))
      .catch(() => {
        /* keep current rows; Refresh or the next event retries */
      })
  }
  useLiveRefresh((e) => e.type === 'queue', refreshQuietly)

  /** Replaces a row with the queue the API returned (persisted state). */
  const applySaved = (saved) =>
    setResult((r) => ({ ...r, data: r.data.map((q) => (q.id === saved.id ? saved : q)) }))

  const togglePause = async (queue) => {
    const pausing = queue.status === 'ACTIVE'
    setBusyId(queue.id)
    try {
      const res = pausing ? await queuesApi.pause(queue.id) : await queuesApi.resume(queue.id)
      applySaved(res.data)
      toast.success(pausing ? `Paused ${queue.name}` : `Resumed ${queue.name}`)
    } catch (err) {
      toast.error(err.message)
      if (err.status === 404 || err.status === 409) reload()
    } finally {
      setBusyId(null)
    }
  }

  const onSaved = (saved) => {
    const created = !modal?.queue
    setModal(null)
    toast.success(created ? `Created ${saved.name}` : `Saved ${saved.name}`)
    // A new queue (or one whose status no longer matches the filter) needs a fresh list.
    if (created || (status && saved.status !== status)) reload()
    else applySaved(saved)
  }

  const filtered = Boolean(search || status)
  const loading = result.key !== requestKey
  const { data, meta } = result
  const error = loading ? null : result.error

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Queues</h1>
          <p className="muted">Create queues, tune their limits, and pause or resume dispatch.</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => setModal({})}>
          New queue
        </button>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search by name"
          aria-label="Search queues by name"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <div className="segmented" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              className={status === f.value ? 'active' : ''}
              aria-pressed={status === f.value}
              onClick={() => updateParams({ status: f.value, page: 1 })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && data.length === 0 ? (
        <Spinner label="Loading queues…" />
      ) : data.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No matching queues"
            action={
              <button
                type="button"
                className="button"
                onClick={() => {
                  setSearchInput('')
                  updateParams({ search: '', status: '', page: 1 })
                }}
              >
                Clear filters
              </button>
            }
          >
            Nothing matches the current search or status filter.
          </EmptyState>
        ) : (
          <EmptyState
            title="No queues yet"
            action={
              <button type="button" className="button button-primary" onClick={() => setModal({})}>
                Create your first queue
              </button>
            }
          >
            A queue holds jobs and controls how many of them run at once.
          </EmptyState>
        )
      ) : (
        <>
          <div className={`table-wrap${loading ? ' is-refreshing' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Concurrency
                  </th>
                  <th scope="col">Job defaults</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((queue) => (
                  <tr key={queue.id}>
                    <td>
                      <Link to={`/queues/${queue.id}/jobs`} className="cell-title">
                        {queue.name}
                      </Link>
                      {queue.description && <div className="cell-sub">{queue.description}</div>}
                    </td>
                    <td>
                      <StatusBadge status={queue.status} />
                    </td>
                    <td className="num">{queue.concurrency}</td>
                    <td className="cell-sub">
                      {queue.defaultJobOptions?.maxAttempts ?? 3} attempts · priority{' '}
                      {queue.defaultJobOptions?.priority ?? 0}
                    </td>
                    <td className="cell-sub">{formatDateTime(queue.createdAt)}</td>
                    <td className="actions">
                      {queue.status !== 'ARCHIVED' && (
                        <button
                          type="button"
                          className="button button-small"
                          disabled={busyId === queue.id}
                          aria-label={`${queue.status === 'ACTIVE' ? 'Pause' : 'Resume'} ${queue.name}`}
                          onClick={() => togglePause(queue)}
                        >
                          {queue.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                        </button>
                      )}
                      <Link
                        className="button button-small"
                        to={`/queues/${queue.id}/jobs`}
                        aria-label={`Jobs in ${queue.name}`}
                      >
                        Jobs
                      </Link>
                      <button
                        type="button"
                        className="button button-small"
                        aria-label={`Edit ${queue.name}`}
                        onClick={() => setModal({ queue })}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination meta={meta} onPageChange={(p) => updateParams({ page: p })} />
        </>
      )}

      {modal && <QueueFormModal queue={modal.queue} onClose={() => setModal(null)} onSaved={onSaved} />}
    </section>
  )
}
