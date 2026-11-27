/**
 * Explicit response shapes. Internal columns (password hashes, lease owner,
 * fencing token) are never returned by accident when the schema grows.
 */
export const serializeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  status: user.status,
  createdAt: user.createdAt,
});

export const serializeQueue = (queue) => ({
  id: queue.id,
  name: queue.name,
  description: queue.description,
  status: queue.status,
  concurrency: queue.concurrency,
  defaultJobOptions: queue.defaultJobOptions,
  createdAt: queue.createdAt,
  updatedAt: queue.updatedAt,
});

export const serializeAttempt = (attempt) => ({
  id: attempt.id,
  attemptNumber: attempt.attemptNumber,
  workerId: attempt.workerId,
  status: attempt.status,
  startedAt: attempt.startedAt,
  finishedAt: attempt.finishedAt,
  durationMs: attempt.durationMs,
  errorCode: attempt.errorCode,
  errorMessage: attempt.errorMessage,
  result: attempt.result,
});

export const serializeJob = (job, { attempts } = {}) => ({
  id: job.id,
  queueId: job.queueId,
  name: job.name,
  payload: job.payload,
  status: job.status,
  priority: job.priority,
  attemptsMade: job.attemptsMade,
  maxAttempts: job.maxAttempts,
  idempotencyKey: job.idempotencyKey,
  scheduledAt: job.scheduledAt,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
  cancelRequestedAt: job.cancelRequestedAt,
  result: job.result,
  lastError: job.lastError,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  ...(attempts ? { attempts: attempts.map(serializeAttempt) } : {}),
});

export const paginationMeta = ({ page, limit, total }) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});
