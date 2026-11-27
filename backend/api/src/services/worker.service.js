import { Queue } from '../models/index.js';
import { workerRepository } from '../repositories/worker.repository.js';
import { paginationMeta } from './serializers.js';

/**
 * Workers are shared infrastructure, not owned by a user, so every
 * authenticated user can see the worker list (status, capacity, heartbeat).
 * What a worker consumes is filtered per caller: `consumesAllQueues` for
 * WORKER_QUEUES="*", otherwise only the IDs of queues the caller owns, so
 * other tenants' queue IDs are never revealed.
 */
const serializeWorker = (row, ownedQueueIds) => {
  const queues = Array.isArray(row.queues) ? row.queues : [];
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    processId: row.process_id,
    status: row.status,
    concurrency: row.concurrency,
    activeJobs: row.active_jobs,
    consumesAllQueues: queues.includes('*'),
    queueIds: queues.filter((id) => ownedQueueIds.has(id)),
    lastHeartbeatAt: row.last_heartbeat_at,
    heartbeatAgeMs: row.heartbeat_age_ms === null ? null : Number(row.heartbeat_age_ms),
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
  };
};

export const workerService = {
  async list({ userId, page, limit, status }) {
    const [{ rows, total, statusCounts }, owned] = await Promise.all([
      workerRepository.list({ statuses: status, limit, offset: (page - 1) * limit }),
      Queue.findAll({ where: { userId }, attributes: ['id'], raw: true }),
    ]);
    const ownedQueueIds = new Set(owned.map((q) => q.id));
    return {
      data: rows.map((row) => serializeWorker(row, ownedQueueIds)),
      meta: { ...paginationMeta({ page, limit, total }), statusCounts },
    };
  },
};
