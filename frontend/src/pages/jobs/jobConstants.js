export const JOB_STATUSES = ['SCHEDULED', 'WAITING', 'ACTIVE', 'RETRYING', 'COMPLETED', 'FAILED', 'DEAD', 'CANCELLED']

/** Statuses the API accepts a cancel for (ACTIVE is cooperative: it stops when the handler returns). */
export const CANCELLABLE = new Set(['SCHEDULED', 'WAITING', 'RETRYING', 'ACTIVE'])

/** An ACTIVE job whose cancel was requested but whose handler hasn't stopped yet. */
export const isCancelling = (job) => job.status === 'ACTIVE' && Boolean(job.cancelRequestedAt)

export const canCancel = (job) => CANCELLABLE.has(job.status) && !isCancelling(job)

/** Built-in handlers registered by every worker (src/worker/handlers/builtin.js). */
export const BUILTIN_HANDLERS = ['system.echo', 'system.sleep', 'system.fail']

/** User-facing message for a cancel response. */
export const cancelMessage = (job) =>
  job.status === 'CANCELLED'
    ? 'Job cancelled'
    : job.status === 'ACTIVE'
      ? 'Cancellation requested. The job stops when its handler returns.'
      : `Job already ${job.status.toLowerCase()}`
