import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { jobsApi, queuesApi } from '../../api/endpoints.js'
import { useToast } from '../../components/Toasts.jsx'
import { EmptyState, ErrorState, Spinner, StatusBadge } from '../../components/ui.jsx'
import { useApiQuery } from '../../hooks/useApiQuery.js'
import { useLiveRefresh } from '../../realtime/useLiveRefresh.js'
import { formatDuration, formatTimestamp, prettyJson, shortId } from '../../utils/format.js'
import { cancelMessage, canCancel, isCancelling } from './jobConstants.js'

function JsonBlock({ value, empty = '—' }) {
  if (value === null || value === undefined) return <p className="muted">{empty}</p>
  return <pre className="code-block">{prettyJson(value)}</pre>
}

function Detail({ label, children }) {
  return (
    <div className="detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function AttemptTimeline({ attempts }) {
  if (!attempts?.length) {
    return <p className="muted">No attempts yet. The job hasn’t been picked up by a worker.</p>
  }
  return (
    <ol className="timeline">
      {attempts.map((a) => (
        <li key={a.id} className={`timeline-item timeline-${a.status.toLowerCase()}`}>
          <div className="timeline-head">
            <strong>Attempt {a.attemptNumber}</strong>
            <StatusBadge status={a.status} />
            <span className="cell-sub">{formatDuration(a.durationMs)}</span>
          </div>
          <dl className="timeline-meta">
            <Detail label="Started">{formatTimestamp(a.startedAt)}</Detail>
            <Detail label="Finished">{a.finishedAt ? formatTimestamp(a.finishedAt) : 'Still running'}</Detail>
            <Detail label="Worker">
              <span className="mono" title={a.workerId ?? undefined}>
                {a.workerId ? shortId(a.workerId) : 'unknown'}
              </span>
            </Detail>
          </dl>
          {(a.errorCode || a.errorMessage) && (
            <div className="error-box">
              {a.errorCode && <span className="mono">{a.errorCode}</span>}
              {a.errorMessage && <p>{a.errorMessage}</p>}
            </div>
          )}
          {a.result !== null && a.result !== undefined && <JsonBlock value={a.result} />}
        </li>
      ))}
    </ol>
  )
}

/** One job: summary, payload, result or error, and the full attempt history. */
export function JobDetailPage() {
  const { jobId } = useParams()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const job = useApiQuery(`job:${jobId}`, (signal) => jobsApi.get(jobId, { signal }))
  const queueId = job.data?.queueId
  const queue = useApiQuery(`queue:${queueId ?? ''}`, (signal) =>
    queueId ? queuesApi.get(queueId, { signal }) : Promise.resolve({ data: null })
  )

  // Live updates: any change of this job (status, attempts, cancel progress).
  useLiveRefresh((e) => e.type === 'job' && e.id === jobId, job.refresh)

  const cancel = async () => {
    const j = job.data
    const prompt =
      j.status === 'ACTIVE'
        ? 'Ask the running job to stop? It is cancelled once its handler returns.'
        : 'Cancel this job? It will not run.'
    if (!window.confirm(prompt)) return
    setBusy(true)
    try {
      const res = await jobsApi.cancel(j.id)
      // The cancel response has no attempts; keep the ones already loaded.
      job.setData((current) => ({ ...res.data, attempts: current.attempts }))
      toast.success(cancelMessage(res.data))
    } catch (err) {
      toast.error(err.message)
      job.reload()
    } finally {
      setBusy(false)
    }
  }

  if (job.error) {
    return job.error.status === 404 || job.error.status === 400 ? (
      <EmptyState title="Job not found" action={<Link to="/queues">Back to queues</Link>}>
        It doesn’t exist, was removed by retention, or isn’t yours.
      </EmptyState>
    ) : (
      <ErrorState error={job.error} onRetry={job.reload} />
    )
  }
  if (!job.data) return <Spinner label="Loading job…" />

  const j = job.data
  const queueName = queue.data?.name

  return (
    <section className={job.loading ? 'is-refreshing' : undefined}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/queues">Queues</Link> <span aria-hidden="true">/</span>{' '}
        <Link to={`/queues/${j.queueId}/jobs`}>{queueName ?? 'Queue'}</Link> <span aria-hidden="true">/</span>{' '}
        <span className="mono">{shortId(j.id)}</span>
      </nav>

      <div className="page-header">
        <div>
          <h1 className="title-with-badge">
            {j.name} <StatusBadge status={j.status} />
          </h1>
          <p className="muted mono">{j.id}</p>
          {isCancelling(j) && (
            <p className="alert alert-info inline-alert">
              Cancellation requested {formatTimestamp(j.cancelRequestedAt)}. The job stays active until its handler
              returns.
            </p>
          )}
        </div>
        <div className="header-actions">
          <button type="button" className="button" onClick={job.reload} disabled={job.loading}>
            Refresh
          </button>
          {canCancel(j) && (
            <button type="button" className="button button-danger" onClick={cancel} disabled={busy}>
              {j.status === 'ACTIVE' ? 'Request cancel' : 'Cancel job'}
            </button>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <div className="card">
          <h2>Summary</h2>
          <dl className="details">
            <Detail label="Attempts">
              {j.attemptsMade} of {j.maxAttempts}
            </Detail>
            <Detail label="Priority">{j.priority}</Detail>
            <Detail label="Created">{formatTimestamp(j.createdAt)}</Detail>
            {j.scheduledAt && (
              <Detail label={j.status === 'RETRYING' ? 'Next retry' : 'Scheduled for'}>
                {formatTimestamp(j.scheduledAt)}
              </Detail>
            )}
            <Detail label="Started">{formatTimestamp(j.startedAt)}</Detail>
            <Detail label="Finished">{formatTimestamp(j.completedAt)}</Detail>
            {j.cancelRequestedAt && <Detail label="Cancel requested">{formatTimestamp(j.cancelRequestedAt)}</Detail>}
            <Detail label="Idempotency key">
              <span className="mono">{j.idempotencyKey ?? '—'}</span>
            </Detail>
            <Detail label="Updated">{formatTimestamp(j.updatedAt)}</Detail>
          </dl>
        </div>

        <div className="card">
          <h2>Payload</h2>
          <JsonBlock value={j.payload} />
          <h2>Result</h2>
          <JsonBlock value={j.result} empty={j.status === 'COMPLETED' ? 'No result returned' : 'No result yet'} />
          {j.lastError && (
            <>
              <h2>Last error</h2>
              <div className="error-box">
                <span className="mono">{j.lastError.code}</span>
                {j.lastError.attempt && <span className="cell-sub"> · attempt {j.lastError.attempt}</span>}
                <p>{j.lastError.message}</p>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Attempts</h2>
        <AttemptTimeline attempts={j.attempts} />
      </div>
    </section>
  )
}
