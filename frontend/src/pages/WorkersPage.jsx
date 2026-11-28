import { useEffect, useState } from 'react'
import { workersApi } from '../api/endpoints.js'
import { useLiveRefresh } from '../realtime/useLiveRefresh.js'
import { EmptyState, ErrorState, Pagination, Spinner, StatusBadge } from '../components/ui.jsx'
import { useApiQuery } from '../hooks/useApiQuery.js'
import { useUrlParams } from '../hooks/useUrlParams.js'
import { formatAge, formatDateTime, shortId } from '../utils/format.js'

const PAGE_SIZE = 20
const AGE_TICK_MS = 5000
const STATUSES = ['RUNNING', 'DRAINING', 'UNHEALTHY', 'STARTING', 'STOPPED']

const STATUS_HELP = {
  RUNNING: 'Consuming jobs and heartbeating.',
  DRAINING: 'Shutting down: finishing in-flight jobs, taking no new ones.',
  UNHEALTHY: 'Missed heartbeats. Its jobs are recovered when their leases expire.',
  STARTING: 'Registering.',
  STOPPED: 'Shut down cleanly.',
}

function Capacity({ active, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((active / total) * 100)) : 0
  const tone = pct >= 90 ? 'capacity-high' : pct >= 60 ? 'capacity-mid' : ''
  return (
    <div className="capacity" title={`${active} of ${total} slots in use (${pct}%)`}>
      <span className="num">
        {active} / {total}
      </span>
      <span className={`capacity-bar ${tone}`} aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
    </div>
  )
}

function workerActivityState(w) {
  if (w.status === 'STOPPED') return { label: 'Offline', cls: 'neutral' }
  if (w.status === 'UNHEALTHY') return { label: 'Unhealthy', cls: 'danger' }
  if (w.status === 'DRAINING') return { label: 'Draining', cls: 'warning' }
  if (w.status === 'STARTING') return { label: 'Starting', cls: 'warning' }
  return w.activeJobs > 0 ? { label: 'Busy', cls: 'primary' } : { label: 'Idle', cls: 'success' }
}

function heartbeatTone(ageMs, status) {
  if (status === 'STOPPED') return 'neutral'
  if (status === 'UNHEALTHY' || ageMs === null || ageMs > 45_000) return 'danger'
  if (ageMs > 15_000) return 'warning'
  return 'success'
}

const queuesLabel = (w) => {
  if (w.consumesAllQueues) return 'All queues'
  if (w.queueIds.length === 0) return 'None of your queues'
  return `${w.queueIds.length} of your queues`
}

/** Worker health. Status filter and page are in the URL; data comes from the API. */
export function WorkersPage() {
  const { params, page, update } = useUrlParams()
  const status = params.get('status') ?? ''
  const workers = useApiQuery(JSON.stringify(['workers', page, status]), (signal) =>
    workersApi.list({ page, limit: PAGE_SIZE, status }, { signal })
  )
  // Live updates on worker status / active-job changes. Heartbeats themselves
  // aren't pushed, so ages advance locally between reloads.
  useLiveRefresh((e) => e.type === 'worker', workers.refresh, { delayMs: 500 })
  const [now, setNow] = useState(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const elapsed = now && workers.receivedAt ? Math.max(0, now - workers.receivedAt) : 0
  const heartbeatAge = (w) => (w.heartbeatAgeMs === null ? null : w.heartbeatAgeMs + elapsed)

  const rows = workers.data ?? []
  const counts = workers.meta?.statusCounts ?? {}
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Workers</h1>
          <p className="muted">Worker processes, their capacity and heartbeats. Shared by all queues.</p>
        </div>
        <button type="button" className="button" onClick={workers.reload} disabled={workers.loading}>
          Refresh
        </button>
      </div>

      {workers.meta && (
        <div className="worker-summary-pills" aria-label="Cluster worker summary">
          <span className="summary-pill">
            <span className="dot dot-success" aria-hidden="true" />
            Running: <strong>{counts.RUNNING ?? 0}</strong>
          </span>
          <span className="summary-pill">
            <span className="dot dot-warning" aria-hidden="true" />
            Draining: <strong>{counts.DRAINING ?? 0}</strong>
          </span>
          <span className="summary-pill">
            <span className="dot dot-danger" aria-hidden="true" />
            Unhealthy: <strong>{counts.UNHEALTHY ?? 0}</strong>
          </span>
          <span className="summary-pill">
            Total: <strong>{totalAll}</strong>
          </span>
        </div>
      )}

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter by status">
          <button
            type="button"
            className={status === '' ? 'active' : ''}
            aria-pressed={status === ''}
            onClick={() => update({ status: '', page: 1 })}
          >
            All{workers.meta ? ` (${totalAll})` : ''}
          </button>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={status === s ? 'active' : ''}
              aria-pressed={status === s}
              title={STATUS_HELP[s]}
              onClick={() => update({ status: s, page: 1 })}
            >
              {s.charAt(0) + s.slice(1).toLowerCase()}
              {workers.meta ? ` (${counts[s] ?? 0})` : ''}
            </button>
          ))}
        </div>
      </div>

      {workers.error ? (
        <ErrorState error={workers.error} onRetry={workers.reload} />
      ) : workers.loading && rows.length === 0 ? (
        <Spinner label="Loading workers…" />
      ) : rows.length === 0 ? (
        status ? (
          <EmptyState
            title={`No ${status.toLowerCase()} workers`}
            action={
              <button type="button" className="button" onClick={() => update({ status: '', page: 1 })}>
                Show all
              </button>
            }
          />
        ) : (
          <EmptyState title="No workers have registered yet">
            Start one with <code>npm run worker</code> in <code>backend/api</code>.
          </EmptyState>
        )
      ) : (
        <>
          <div className={`table-wrap${workers.loading ? ' is-refreshing' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Worker</th>
                  <th scope="col">Status</th>
                  <th scope="col">Active jobs</th>
                  <th scope="col">Last heartbeat</th>
                  <th scope="col">Queues</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const age = heartbeatAge(w)
                  const hbTone = heartbeatTone(age, w.status)
                  const activity = workerActivityState(w)
                  return (
                    <tr key={w.id}>
                      <td>
                        <div className="cell-title">{w.name}</div>
                        <div className="cell-sub mono" title={w.id}>
                          {shortId(w.id)} · {w.hostname} · pid {w.processId}
                        </div>
                      </td>
                      <td>
                        <div className="worker-status-cell">
                          <span title={STATUS_HELP[w.status]}>
                            <StatusBadge status={w.status} />
                          </span>
                          <span className={`activity-tag activity-${activity.cls}`}>{activity.label}</span>
                        </div>
                      </td>
                      <td>
                        <Capacity active={w.status === 'STOPPED' ? 0 : w.activeJobs} total={w.concurrency} />
                      </td>
                      <td title={w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toLocaleString() : undefined}>
                        {w.status === 'STOPPED' ? (
                          '—'
                        ) : (
                          <span className="heartbeat-cell">
                            <span className={`dot dot-${hbTone}`} aria-hidden="true" />
                            <span>{formatAge(age)}</span>
                          </span>
                        )}
                      </td>
                      <td className="cell-sub">{queuesLabel(w)}</td>
                      <td className="cell-sub">
                        {formatDateTime(w.startedAt)}
                        {w.stoppedAt && <div>Stopped {formatDateTime(w.stoppedAt)}</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pagination meta={workers.meta} onPageChange={(p) => update({ page: p })} />
        </>
      )}
    </section>
  )
}
