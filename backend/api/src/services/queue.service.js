import { UniqueConstraintError } from 'sequelize';
import { queueRepository } from '../repositories/queue.repository.js';
import { conflict, notFound } from '../utils/AppError.js';
import { paginationMeta, serializeQueue } from './serializers.js';

const nameTaken = (name) =>
  conflict(`A queue named "${name}" already exists`, 'QUEUE_NAME_TAKEN');

/** Loads a queue owned by the user. Missing and foreign queues both return 404. */
export const getOwnedQueue = async ({ userId, queueId }) => {
  const queue = await queueRepository.findForUser({ queueId, userId });
  if (!queue) {
    throw notFound('Queue');
  }
  return queue;
};

export const queueService = {
  async create({ userId, name, description, concurrency, defaultJobOptions }) {
    try {
      const queue = await queueRepository.create({
        userId,
        name,
        description: description ?? null,
        concurrency,
        defaultJobOptions: defaultJobOptions ?? {},
      });
      return serializeQueue(queue);
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw nameTaken(name);
      }
      throw err;
    }
  },

  async list({ userId, page, limit, status }) {
    const { rows, count } = await queueRepository.listForUser({
      userId,
      statuses: status,
      limit,
      offset: (page - 1) * limit,
    });
    return { data: rows.map(serializeQueue), meta: paginationMeta({ page, limit, total: count }) };
  },

  async get({ userId, queueId }) {
    return serializeQueue(await getOwnedQueue({ userId, queueId }));
  },

  async update({ userId, queueId, changes }) {
    const queue = await getOwnedQueue({ userId, queueId });
    try {
      return serializeQueue(await queueRepository.update(queue, changes));
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw nameTaken(changes.name);
      }
      throw err;
    }
  },
};
