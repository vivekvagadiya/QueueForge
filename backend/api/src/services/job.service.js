import { isDeepStrictEqual } from 'node:util';
import { getDatabase } from '../config/database.js';
import { jobRepository } from '../repositories/job.repository.js';
import { outboxRepository } from '../repositories/outbox.repository.js';
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

    // The job and its job.ready outbox event commit together or not at all, so
    // a committed job can never miss its notification (ADR-004). SCHEDULED jobs
    // get their event later, when the scheduler (recovery process) releases them.
    const job = await getDatabase().transaction(async (transaction) => {
      const inserted = await jobRepository.insertUnlessDuplicateKey(
        {
          queueId,
          name: input.name,
          payload: input.payload,
          status,
          scheduledAt,
          priority: input.priority ?? defaults.priority ?? DEFAULT_PRIORITY,
          maxAttempts: input.maxAttempts ?? defaults.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          idempotencyKey,
        },
        { transaction }
      );
      if (inserted && inserted.status === 'WAITING') {
        await outboxRepository.createJobReady(inserted, { transaction });
      }
      return inserted;
    });

    if (job) {
      return { job: serializeJob(job), created: true };
    }

    // A concurrent submission with the same key won the insert; return its job.
    const existing = await jobRepository.findByIdempotencyKey({ queueId, idempotencyKey });
    if (!existing) {
      throw new Error('Idempotency conflict reported but no existing job was found');
    }
    return assertSameRequest(existing, input);
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

  /**
   * Cancels a job. Returns `{ job, pending }`: `pending` is true when the job is
   * ACTIVE and its handler has been asked to stop; the job then stays ACTIVE
   * (with cancelRequestedAt set) until the worker confirms the handler returned.
   * Cancelling a CANCELLED job is a no-op; other finished jobs return 409.
   */
  async cancel({ userId, jobId }) {
    const owned = await jobRepository.findForUser({ jobId, userId });
    if (!owned) {
      throw notFound('Job');
    }
    const status = await jobRepository.requestCancel(owned.id);
    const job = await jobRepository.findById(owned.id);
    if (status === null && job.status !== 'CANCELLED') {
      throw conflict(`Job is ${job.status} and can no longer be cancelled`, 'JOB_NOT_CANCELLABLE', {
        status: job.status,
      });
    }
    // The re-read may already show a later state (e.g. the worker finished).
    return { job: serializeJob(job), pending: job.status === 'ACTIVE' };
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
