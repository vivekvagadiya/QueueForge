import { healthApi, workersApi } from '../api/endpoints.js'
import { ErrorState, Spinner, StatusBadge } from '../components/ui.jsx'
import { useApiQuery } from '../hooks/useApiQuery.js'
import { useRealtime } from '../realtime/RealtimeProvider.jsx'
import { useLiveRefresh } from '../realtime/useLiveRefresh.js'
import { formatDuration, formatTimestamp } from '../utils/format.js'

const OVERALL_LABEL = {
  ok: { text: 'Healthy', cls: 'active', desc: 'All critical and supporting services are operational.' },
  degraded: {
    text: 'Degraded',
    cls: 'paused',
    desc: 'API is serving requests, but a non-critical dependency needs attention.',
  },
  unavailable: {
    text: 'Unavailable',
    cls: 'failed',
    desc: 'A critical dependency is down and readiness checks are failing.',
  },
  shutting_down: {
    text: 'Unavailable',
    cls: 'failed',
    desc: 'The API server is shutting down.',
  },
}

function checkStatusBadge(check) {
  if (!check) return { label: 'Unknown', cls: 'neutral' }
  if (check.status === 'up') return { label: 'Healthy', cls: 'active' }
  return check.critical ? { label: 'Unavailable', cls: 'failed' } : { label: 'Degraded', cls: 'paused' }
}

function summarizeWorkers(workersData, workersError) {
  if (workersError) {
    return {
      status: { label: 'Unknown', cls: 'neutral' },
      detail: workersError.message ?? 'Could not query worker status.',
    }
  }
  if (!workersData) {
    return { status: { label: 'Unknown', cls: 'neutral' }, detail: 'Loading worker status…' }
  }
  const counts = workersData.meta?.statusCounts ?? {}
  const running = counts.RUNNING ?? 0
  const unhealthy = counts.UNHEALTHY ?? 0
  const draining = counts.DRAINING ?? 0

  if (running > 0 && unhealthy === 0) {
    return {
      status: { label: 'Healthy', cls: 'active' },
      detail: `${running} running${draining > 0 ? `, ${draining} draining` : ''}.`,
    }
  }
  if (running > 0 && unhealthy > 0) {
    return {
      status: { label: 'Degraded', cls: 'paused' },
      detail: `${running} running, ${unhealthy} unhealthy.`,
    }
  }
  if (unhealthy > 0) {
    return {
      status: { label: 'Unavailable', cls: 'failed' },
      detail: `0 running, ${unhealthy} unhealthy.`,
    }
  }
  return {
    status: { label: 'Unavailable', cls: 'failed' },
    detail: 'No running workers registered.',
  }
}

export function HealthPage() {
  const { status: socketStatus } = useRealtime()
  const health = useApiQuery('system-health', (signal) => healthApi.ready({ signal }))
  const workers = useApiQuery('health-workers', (signal) =>
    workersApi.list({ page: 1, limit: 50 }, { signal }).then((res) => ({ data: res })),
  )

  useLiveRefresh(
    (e) => e.type === 'worker',
    () => {
      health.refresh()
      workers.refresh()
    },
    { delayMs: 500 },
  )

  const readiness = health.data
  const overall = OVERALL_LABEL[readiness?.status] ?? {
    text: 'Unknown',
    cls: 'neutral',
    desc: 'Readiness status unavailable.',
  }

  const pgCheck = readiness?.checks?.postgres
  const redisCheck = readiness?.checks?.redis
  const realtimeCheck = readiness?.checks?.realtime
  const workerSummary = summarizeWorkers(workers.data, workers.error)

  const services = [
    {
      name: 'API Server',
      role: 'Core HTTP & Auth',
      badge: readiness ? { label: 'Healthy', cls: 'active' } : { label: 'Unavailable', cls: 'failed' },
      detail: readiness ? 'Responding to readiness probes.' : 'API did not respond.',
      latencyMs: null,
      error: null,
    },
    {
      name: 'PostgreSQL',
      role: pgCheck?.critical === false ? 'Optional' : 'Critical',
      badge: checkStatusBadge(pgCheck),
      detail: pgCheck?.status === 'up' ? 'Database query check passed.' : 'Database check failed.',
      latencyMs: pgCheck?.latencyMs ?? null,
      error: pgCheck?.error ?? null,
    },
    {
      name: 'Redis',
      role: redisCheck?.critical ? 'Critical' : 'Non-critical (API)',
      badge: checkStatusBadge(redisCheck),
      detail:
        redisCheck?.status === 'up'
          ? 'PING succeeded.'
          : 'Redis unavailable; workers cannot consume jobs until restored.',
      latencyMs: redisCheck?.latencyMs ?? null,
      error: redisCheck?.error ?? null,
    },
    {
      name: 'Realtime & Socket.IO',
      role: 'Live invalidation',
      badge:
        realtimeCheck?.status === 'up' && socketStatus === 'live'
          ? { label: 'Healthy', cls: 'active' }
          : realtimeCheck?.status === 'up'
            ? { label: 'Degraded', cls: 'paused' }
            : checkStatusBadge(realtimeCheck),
      detail: `PG listener: ${realtimeCheck?.status ?? 'unknown'} · Browser Socket.IO: ${socketStatus}`,
      latencyMs: realtimeCheck?.latencyMs ?? null,
      error: realtimeCheck?.error ?? null,
    },
    {
      name: 'Workers',
      role: 'Job execution',
      badge: workerSummary.status,
      detail: workerSummary.detail,
      latencyMs: null,
      error: null,
    },
  ]

  return (
    <section>
      <div className="page-header">
        <div>
          <div className="title-with-badge">
            <h1>System Health</h1>
            {readiness && <span className={`badge badge-${overall.cls}`}>{overall.text}</span>}
          </div>
          <p className="muted">
            Live dependency readiness from <code className="mono">/api/v1/health/ready</code> and worker heartbeats.
          </p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => {
            health.reload()
            workers.reload()
          }}
          disabled={health.loading}
        >
          Refresh
        </button>
      </div>

      {health.error ? (
        <ErrorState error={health.error} onRetry={health.reload} />
      ) : health.loading && !readiness ? (
        <Spinner label="Checking system health…" />
      ) : (
        <div className={health.loading ? 'is-refreshing' : ''}>
          <div className="card health-summary-card">
            <div className="health-summary-row">
              <div>
                <div className="title-with-badge">
                  <h2>Overall Status</h2>
                  <StatusBadge status={overall.text} />
                </div>
                <p className="muted">{overall.desc}</p>
              </div>
              <div className="health-timestamp">
                <span className="cell-sub">Last checked</span>
                <span className="mono">{formatTimestamp(readiness?.timestamp)}</span>
              </div>
            </div>
          </div>

          <div className="health-grid">
            {services.map((svc) => (
              <article key={svc.name} className="card health-card">
                <div className="health-card-head">
                  <div>
                    <h3>{svc.name}</h3>
                    <span className="cell-sub">{svc.role}</span>
                  </div>
                  <span className={`badge badge-${svc.badge.cls}`}>{svc.badge.label}</span>
                </div>
                <p className="health-card-detail">{svc.detail}</p>
                <div className="health-card-meta">
                  {svc.latencyMs !== null && (
                    <span className="cell-sub mono">Check latency: {formatDuration(svc.latencyMs)}</span>
                  )}
                  {svc.error && <span className="health-error-code mono">Error: {svc.error}</span>}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
