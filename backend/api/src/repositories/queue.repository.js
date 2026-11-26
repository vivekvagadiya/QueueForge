import { Op } from 'sequelize';
import { Queue } from '../models/index.js';

/** Every read is scoped to the owning user; there is no lookup by ID alone. */
export const queueRepository = {
  create: (fields) => Queue.create(fields),

  findForUser: ({ queueId, userId }) => Queue.findOne({ where: { id: queueId, userId } }),

  listForUser: ({ userId, statuses, limit, offset }) =>
    Queue.findAndCountAll({
      where: { userId, ...(statuses ? { status: { [Op.in]: statuses } } : {}) },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset,
    }),

  update: (queue, changes) => queue.update(changes),
};
