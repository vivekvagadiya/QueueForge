import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { jobsApi, queuesApi } from '../../api/endpoints.js'
import { useToast } from '../../components/Toasts.jsx'
import { EmptyState, ErrorState, Pagination, Spinner, StatusBadge } from '../../components/ui.jsx'
import { useApiQuery } from '../../hooks/useApiQuery.js'
import { useDebouncedUrlValue, useUrlParams } from '../../hooks/useUrlParams.js'
import { useLiveRefresh } from '../../realtime/useLiveRefresh.js'
import { formatDateTime, shortId } from '../../utils/format.js'
import { cancelMessage, canCancel, isCancelling, JOB_STATUSES } from './jobConstants.js'
import { SubmitJobModal } from './SubmitJobModal.jsx'

const PAGE_SIZE = 20

/** When the job will run or ran: scheduled time for future work, else started/created. */
const timingLabel = (job) => {
  if (job.status === 'SCHEDULED') return `Runs ${formatDateTime(job.scheduledAt)}`
  if (job.status === 'RETRYING') return `Retry ${formatDateTime(job.scheduledAt)}`
  if (job.completedAt) return `Finished ${formatDateTime(job.completedAt)}`
  if (job.startedAt) return `Started ${formatDateTime(job.startedAt)}`
  return `Created ${formatDateTime(job.createdAt)}`
}

/**
 * Jobs of one queue. Search, status filter and page are in the URL; the list
 * is always reloaded from the API, and actions apply the job the API returns.
 */
export function JobsPage() {
  const { queueId } = useParams()
  const toast = useToast()
  const { params, page, update } = useUrlParams()
  const search = params.get('search') ?? ''
  const status = params.get('status') ?? ''
  const [searchInput, setSearchInput] = useDebouncedUrlValue(search, (value) => update({ search: value, page: 1 }))
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const queue = useApiQuery(`queue:${queueId}`, (signal) => queuesApi.get(queueId, { signal }))
  const jobs = useApiQuery(
    JSON.stringify(['jobs', queueId, page, status, search]),
    (signal) => jobsApi.list(queueId, { page, limit: PAGE_SIZE, status, search }, { signal }),
    {
      onResult: (body) => {
        // A page past the end (e.g. after filtering) jumps to the last page.
        if (body.meta.totalPages > 0 && page > body.meta.totalPages) {
          update({ page: body.meta.totalPages })
          return false
        }
        return true
      },
    }
  )

  // Live updates: job changes in this queue, and changes to the queue itself.
  useLiveRefresh((e) => e.type === 'job' && e.queueId === queueId, jobs.refresh)
  useLiveRefresh((e) => e.type === 'queue' && e.id === queueId, queue.refresh)

  const cancel = async (job) => {
    const running = job.status === 'ACTIVE'
    const prompt = running
      ? `Ask the running job "${job.name}" to stop? It is cancelled once its handler returns.`
      : `Cancel job "${job.name}"? It will not run.`
    if (!window.confirm(prompt)) return
    setBusyId(job.id)
    try {
      const res = await jobsApi.cancel(job.id)
      jobs.setData((rows) => rows.map((j) => (j.id === res.data.id ? res.data : j)))
      toast.success(cancelMessage(res.data))
    } catch (err) {
      toast.error(err.message)
      if (err.status === 409) jobs.reload()
    } finally {
      setBusyId(null)
    }
  }

  const onSubmitted = (job) => {
    setSubmitting(false)
    toast.success(`Submitted ${job.name} (${job.status.toLowerCase()})`)
    jobs.reload()
  }

  if (queue.error) {
    return queue.error.status === 404 ? (
      <EmptyState title="Queue not found" action={<Link to="/queues">Back to queues</Link>}>
        It doesn’t exist or isn’t yours.
      </EmptyState>
    ) : (
      <ErrorState error={queue.error} onRetry={queue.reload} />
    )
  }

  const q = queue.data
  const rows = jobs.data ?? []
  const filtered = Boolean(search || status)

  return (
    <section>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/queues">Queues</Link> <span aria-hidden="true">/</span> <span>{q?.name ?? '…'}</span>
      </nav>
      <div className="page-header">
        <div>
          <h1 className="title-with-badge">
            {q?.name ?? 'Queue'} {q && <StatusBadge status={q.status} />}
          </h1>
          <p className="muted">
            {q ? `Concurrency ${q.concurrency}${q.description ? ` · ${q.description}` : ''}` : 'Loading queue…'}
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="button" onClick={jobs.reload} disabled={jobs.loading}>
            Refresh
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!q || q.status === 'ARCHIVED'}
            title={q?.status === 'ARCHIVED' ? 'Archived queues do not accept jobs' : undefined}
            onClick={() => setSubmitting(true)}
          >
            Submit job
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search by name or job ID"
          aria-label="Search jobs by name or ID"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select
          className="select-inline"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => update({ status: e.target.value, page: 1 })}
        >
          <option value="">All statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>

      {jobs.error ? (
        <ErrorState error={jobs.error} onRetry={jobs.reload} />
      ) : jobs.loading && rows.length === 0 ? (
        <Spinner label="Loading jobs…" />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No matching jobs"
            action={
              <button type="button" className="button" onClick={() => update({ search: '', status: '', page: 1 })}>
                Clear filters
              </button>
            }
          >
            Nothing matches the current search or status filter.
          </EmptyState>
        ) : (
          <EmptyState
            title="No jobs yet"
            action={
              q?.status !== 'ARCHIVED' && (
                <button type="button" className="button button-primary" onClick={() => setSubmitting(true)}>
                  Submit the first job
                </button>
              )
            }
          >
            Jobs submitted to this queue appear here.
          </EmptyState>
        )
      ) : (
        <>
          <div className={`table-wrap${jobs.loading ? ' is-refreshing' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Attempts
                  </th>
                  <th scope="col" className="num">
                    Priority
                  </th>
                  <th scope="col">Timing</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link to={`/jobs/${job.id}`} className="cell-title">
                        {job.name}
                      </Link>
                      <div className="cell-sub mono">{shortId(job.id)}</div>
                    </td>
                    <td>
                      <StatusBadge status={job.status} />
                      {isCancelling(job) && <div className="cell-sub">Cancelling…</div>}
                    </td>
                    <td className="num">
                      {job.attemptsMade} / {job.maxAttempts}
                    </td>
                    <td className="num">{job.priority}</td>
                    <td className="cell-sub">{timingLabel(job)}</td>
                    <td className="actions">
                      {canCancel(job) && (
                        <button
                          type="button"
                          className="button button-small"
                          disabled={busyId === job.id}
                          aria-label={`Cancel ${job.name} ${shortId(job.id)}`}
                          onClick={() => cancel(job)}
                        >
                          Cancel
                        </button>
                      )}
                      <Link className="button button-small" to={`/jobs/${job.id}`}>
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination meta={jobs.meta} onPageChange={(p) => update({ page: p })} />
        </>
      )}

      {submitting && q && <SubmitJobModal queue={q} onClose={() => setSubmitting(false)} onSubmitted={onSubmitted} />}
    </section>
  )
}
