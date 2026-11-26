import { isDeepStrictEqual } from 'node:util';
import { UniqueConstraintError } from 'sequelize';
import { jobRepository } from '../repositories/job.repository.js';
import { badRequest, conflict, notFound } from '../utils/AppError.js';
import { getOwnedQueue } from './queue.service.js';
import { paginationMeta, serializeJob } from './serializers.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PRIORITY = 0;

/** Header and body may both carry the key, but they must agree. */
const resolveIdempotencyKey = (bodyKey, headerKey) => {
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    throw badRequest(
      'Idempotency-Key header and body idempotencyKey differ',
      'IDEMPOTENCY_KEY_MISMATCH'
    );
  }
  return bodyKey ?? headerKey ?? null;
};

/**
 * A replay with the same key must describe the same logical job. Name and
 * payload are compared; scheduling fields are not, because `delayMs` is
 * relative to submission time and differs naturally between retries.
 */
const assertSameRequest = (existing, { name, payload }) => {
  if (existing.name !== name || !isDeepStrictEqual(existing.payload, payload)) {
    throw conflict(
      'Idempotency key was already used for a different job',
      'IDEMPOTENCY_KEY_CONFLICT',
      { jobId: existing.id }
    );
  }
  return { job: serializeJob(existing), created: false };
};

const resolveSchedule = ({ delayMs, scheduledAt }, now) => {
  let runAt = null;
  if (delayMs !== undefined && delayMs > 0) {
    runAt = new Date(now.getTime() + delayMs);
  } else if (scheduledAt !== undefined) {
    runAt = new Date(scheduledAt);
  }
  const isFuture = runAt !== null && runAt > now;
  return { status: isFuture ? 'SCHEDULED' : 'WAITING', scheduledAt: isFuture ? runAt : null };
};

export const jobService = {
  /**
   * Persists a job. Returns `{ job, created }`; `created` is false when an
   * idempotent replay matched an existing job.
   */
  async submit({ userId, queueId, input, headerIdempotencyKey }) {
    const idempotencyKey = resolveIdempotencyKey(input.idempotencyKey, headerIdempotencyKey);
    const queue = await getOwnedQueue({ userId, queueId });

    if (queue.status === 'ARCHIVED') {
      throw conflict('Queue is archived and does not accept new jobs', 'QUEUE_ARCHIVED');
    }

    if (idempotencyKey) {
      const existing = await jobRepository.findByIdempotencyKey({ queueId, idempotencyKey });
      if (existing) {
        return assertSameRequest(existing, input);
      }
    }

    const defaults = queue.defaultJobOptions ?? {};
    const { status, scheduledAt } = resolveSchedule(input, new Date());

    try {
      const job = await jobRepository.create({
        queueId,
        name: input.name,
        payload: input.payload,
        status,
        scheduledAt,
        priority: input.priority ?? defaults.priority ?? DEFAULT_PRIORITY,
        maxAttempts: input.maxAttempts ?? defaults.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        idempotencyKey,
      });
      return { job: serializeJob(job), created: true };
    } catch (err) {
      // Two concurrent submissions with the same key: the unique index lets
      // exactly one insert win; the loser returns the winner's job.
      if (idempotencyKey && err instanceof UniqueConstraintError) {
        const existing = await jobRepository.findByIdempotencyKey({ queueId, idempotencyKey });
        if (existing) {
          return assertSameRequest(existing, input);
        }
      }
      throw err;
    }
  },

  async list({ userId, queueId, page, limit, status }) {
    await getOwnedQueue({ userId, queueId });
    const { rows, count } = await jobRepository.listForQueue({
      queueId,
      statuses: status,
      limit,
      offset: (page - 1) * limit,
    });
    return { data: rows.map((job) => serializeJob(job)), meta: paginationMeta({ page, limit, total: count }) };
  },

  async get({ userId, jobId }) {
    const job = await jobRepository.findForUser({ jobId, userId });
    if (!job) {
      throw notFound('Job');
    }
    const attempts = await jobRepository.listAttempts(job.id);
    return serializeJob(job, { attempts });
  },
};
