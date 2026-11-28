import { useState } from 'react'
import { Link } from 'react-router-dom'
import { dashboardApi, healthApi, queuesApi } from '../api/endpoints.js'
import { Modal } from '../components/Modal.jsx'
import { useToast } from '../components/Toasts.jsx'
import { EmptyState, ErrorState, Spinner, StatusBadge } from '../components/ui.jsx'
import { useApiQuery } from '../hooks/useApiQuery.js'
import { useLiveRefresh } from '../realtime/useLiveRefresh.js'
import { formatAge, formatDateTime, formatDuration, shortId } from '../utils/format.js'

function KpiIcon({ kind }) {
  const props = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }
  switch (kind) {
    case 'queues':
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <rect x="3" y="10" width="18" height="4" rx="1" />
          <rect x="3" y="16" width="18" height="4" rx="1" />
        </svg>
      )
    case 'waiting':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15 14" />
        </svg>
      )
    case 'active':
      return (
        <svg {...props}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      )
    case 'completed':
      return (
        <svg {...props}>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )
    case 'failed':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      )
    default:
      return (
        <svg {...props}>
          <rect x="2" y="3" width="20" height="7" rx="2" />
          <rect x="2" y="14" width="20" height="7" rx="2" />
          <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
          <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
        </svg>
      )
  }
}

function KpiCard({ title, value, description, icon, tone = 'neutral' }) {
  return (
    <div className="kpi-card">
      <div className="kpi-head">
        <span className="kpi-title">{title}</span>
        <span className={`kpi-icon kpi-icon-${tone}`}>
          <KpiIcon kind={icon} />
        </span>
      </div>
      <div className="kpi-value num">{value}</div>
      <div className="kpi-desc">{description}</div>
    </div>
  )
}

function jobDuration(job) {
  if (!job.startedAt || !job.completedAt) return '—'
  const ms = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
  return ms >= 0 ? formatDuration(ms) : '—'
}

const workerQueuesLabel = (w) => {
  const list = Array.isArray(w.queues) ? w.queues : []
  if (list.length === 0) return 'All queues'
  return `${list.length} queue${list.length === 1 ? '' : 's'}`
}

export function DashboardPage() {
  const toast = useToast()
  const dashboard = useApiQuery('dashboard', (signal) => dashboardApi.get({ signal }))
  const health = useApiQuery('dashboard-health', (signal) => healthApi.ready({ signal }))
  const [busyQueueId, setBusyQueueId] = useState(null)
  const [confirmPause, setConfirmPause] = useState(null)

  useLiveRefresh(
    () => true,
    () => {
      dashboard.refresh()
      health.refresh()
    },
    { delayMs: 400 },
  )

  const handleToggleQueue = async (queue) => {
    const pausing = queue.status === 'ACTIVE'
    setBusyQueueId(queue.id)
    try {
      await (pausing ? queuesApi.pause(queue.id) : queuesApi.resume(queue.id))
      toast.success(pausing ? `Paused "${queue.name}"` : `Resumed "${queue.name}"`)
      setConfirmPause(null)
      dashboard.refresh()
    } catch (err) {
      toast.error(err?.message ?? 'Could not update queue')
    } finally {
      setBusyQueueId(null)
    }
  }

  const data = dashboard.data
  const healthStatus = health.data?.status ?? null
  const systemBadge =
    healthStatus === 'ok'
      ? { label: 'Operational', cls: 'active' }
      : healthStatus === 'degraded'
        ? { label: 'Degraded', cls: 'paused' }
        : healthStatus
          ? { label: 'Unavailable', cls: 'failed' }
          : null

  return (
    <section className="dashboard-page">
      <div className="page-header">
        <div>
          <div className="title-with-badge">
            <h1>Overview</h1>
            {systemBadge && <span className={`badge badge-${systemBadge.cls}`}>{systemBadge.label}</span>}
          </div>
          <p className="muted">Real-time snapshot of your queues, jobs, and cluster workers.</p>
        </div>
        <div className="header-actions">
          <Link to="/health" className="button">
            System health
          </Link>
          <button
            type="button"
            className="button"
            onClick={() => {
              dashboard.reload()
              health.reload()
            }}
            disabled={dashboard.loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {dashboard.error ? (
        <ErrorState error={dashboard.error} onRetry={dashboard.reload} />
      ) : dashboard.loading && !data ? (
        <Spinner label="Loading overview…" />
      ) : data ? (
        <div className={dashboard.loading ? 'is-refreshing' : ''}>
          <div className="kpi-grid">
            <KpiCard
              title="Total Queues"
              value={data.queues.total}
              description={`${data.queues.active} active · ${data.queues.paused} paused`}
              icon="queues"
              tone="primary"
            />
            <KpiCard
              title="Waiting Jobs"
              value={data.jobs.waiting + data.jobs.scheduled}
              description={
                data.jobs.scheduled > 0
                  ? `${data.jobs.waiting} ready · ${data.jobs.scheduled} scheduled`
                  : 'Queued for dispatch'
              }
              icon="waiting"
              tone="primary"
            />
            <KpiCard
              title="Active Jobs"
              value={data.jobs.active}
              description={
                data.jobs.retrying > 0 ? `${data.jobs.retrying} retrying` : 'Currently processing'
              }
              icon="active"
              tone="warning"
            />
            <KpiCard
              title="Completed Jobs"
              value={data.jobs.completed}
              description="Finished successfully"
              icon="completed"
              tone="success"
            />
            <KpiCard
              title="Failed Jobs"
              value={data.jobs.failed}
              description="Failed or dead-lettered"
              icon="failed"
              tone={data.jobs.failed > 0 ? 'danger' : 'neutral'}
            />
            <KpiCard
              title="Active Workers"
              value={data.workers.running}
              description={
                data.workers.unhealthy > 0
                  ? `${data.workers.unhealthy} unhealthy · ${data.workers.total} total`
                  : `${data.workers.total} registered`
              }
              icon="workers"
              tone={data.workers.unhealthy > 0 ? 'warning' : 'success'}
            />
          </div>

          {data.queues.total === 0 ? (
            <EmptyState
              title="No queues yet"
              action={
                <Link to="/queues" className="button button-primary">
                  Go to Queues
                </Link>
              }
            >
              Your system is ready. Create your first queue and submit a job to start processing.
            </EmptyState>
          ) : (
            <div className="dashboard-sections">
              <section className="card">
                <div className="section-head">
                  <div>
                    <h2>Queue Overview</h2>
                    <p className="muted">Recent queues with live job counts and dispatch controls.</p>
                  </div>
                  <Link to="/queues" className="button button-small">
                    View all
                  </Link>
                </div>

                <div className="table-wrap table-wrap-embedded">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Queue</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="num">
                          Waiting
                        </th>
                        <th scope="col" className="num">
                          Active
                        </th>
                        <th scope="col" className="num">
                          Completed
                        </th>
                        <th scope="col" className="num">
                          Failed
                        </th>
                        <th scope="col" className="num">
                          Concurrency
                        </th>
                        <th scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentQueues.map((q) => (
                        <tr key={q.id}>
                          <td>
                            <Link to={`/queues/${q.id}/jobs`} className="cell-title">
                              {q.name}
                            </Link>
                          </td>
                          <td>
                            <StatusBadge status={q.status} />
                          </td>
                          <td className="num">{q.waitingCount}</td>
                          <td className="num">{q.activeCount}</td>
                          <td className="num">{q.completedCount}</td>
                          <td className="num">{q.failedCount}</td>
                          <td className="num">{q.concurrency}</td>
                          <td className="actions">
                            <Link to={`/queues/${q.id}/jobs`} className="button button-small">
                              View
                            </Link>
                            {q.status === 'ACTIVE' && (
                              <button
                                type="button"
                                className="button button-small"
                                disabled={busyQueueId === q.id}
                                onClick={() => setConfirmPause(q)}
                              >
                                Pause
                              </button>
                            )}
                            {q.status === 'PAUSED' && (
                              <button
                                type="button"
                                className="button button-small"
                                disabled={busyQueueId === q.id}
                                onClick={() => handleToggleQueue(q)}
                              >
                                Resume
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <div className="dashboard-two-col">
                <section className="card">
                  <div className="section-head">
                    <div>
                      <h2>Recent Jobs</h2>
                      <p className="muted">Latest jobs across your queues.</p>
                    </div>
                  </div>
                  {data.recentJobs.length === 0 ? (
                    <EmptyState title="No jobs submitted yet">
                      Open a queue to submit your first job.
                    </EmptyState>
                  ) : (
                    <div className="table-wrap table-wrap-embedded">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Job</th>
                            <th scope="col">Queue</th>
                            <th scope="col">Status</th>
                            <th scope="col" className="num">
                              Priority
                            </th>
                            <th scope="col">Duration</th>
                            <th scope="col">Created</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.recentJobs.map((job) => (
                            <tr key={job.id}>
                              <td>
                                <Link to={`/jobs/${job.id}`} className="cell-title">
                                  {job.name}
                                </Link>
                                <div className="cell-sub mono">{shortId(job.id)}</div>
                              </td>
                              <td>
                                <Link to={`/queues/${job.queueId}/jobs`}>{job.queueName}</Link>
                              </td>
                              <td>
                                <StatusBadge status={job.status} />
                              </td>
                              <td className="num">{job.priority}</td>
                              <td className="mono">{jobDuration(job)}</td>
                              <td className="cell-sub">{formatDateTime(job.createdAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className="card">
                  <div className="section-head">
                    <div>
                      <h2>Worker Overview</h2>
                      <p className="muted">Active cluster workers and capacity.</p>
                    </div>
                    <Link to="/workers" className="button button-small">
                      View all
                    </Link>
                  </div>
                  {data.activeWorkers.length === 0 ? (
                    <EmptyState title="No active workers">
                      Start a worker process to begin consuming jobs.
                    </EmptyState>
                  ) : (
                    <div className="table-wrap table-wrap-embedded">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Worker</th>
                            <th scope="col">Status</th>
                            <th scope="col">Capacity</th>
                            <th scope="col">Queues</th>
                            <th scope="col">Heartbeat</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.activeWorkers.map((w) => {
                            const pct =
                              w.concurrency > 0
                                ? Math.min(100, Math.round((w.activeJobs / w.concurrency) * 100))
                                : 0
                            return (
                              <tr key={w.id}>
                                <td>
                                  <div className="cell-title">{w.name}</div>
                                  <div className="cell-sub mono">{w.hostname}</div>
                                </td>
                                <td>
                                  <StatusBadge status={w.status} />
                                </td>
                                <td>
                                  <div className="capacity">
                                    <span className="num">
                                      {w.activeJobs} / {w.concurrency}
                                    </span>
                                    <span className="capacity-bar" aria-hidden="true">
                                      <span style={{ width: `${pct}%` }} />
                                    </span>
                                  </div>
                                </td>
                                <td className="cell-sub">{workerQueuesLabel(w)}</td>
                                <td className="cell-sub">{formatAge(w.heartbeatAgeMs)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {confirmPause && (
        <Modal
          title="Pause queue?"
          onClose={() => setConfirmPause(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setConfirmPause(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={busyQueueId === confirmPause.id}
                onClick={() => handleToggleQueue(confirmPause)}
              >
                {busyQueueId === confirmPause.id ? 'Pausing…' : 'Pause queue'}
              </button>
            </>
          }
        >
          <p>
            Pausing <strong>{confirmPause.name}</strong> stops workers from claiming new jobs until you resume it.
            In-flight jobs will continue running.
          </p>
        </Modal>
      )}
    </section>
  )
}
