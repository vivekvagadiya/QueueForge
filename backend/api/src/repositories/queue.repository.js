import { Op } from 'sequelize';
import { Queue } from '../models/index.js';

/** Every read is scoped to the owning user; there is no lookup by ID alone. */
export const queueRepository = {
  create: (fields) => Queue.create(fields),

  findForUser: ({ queueId, userId }) => Queue.findOne({ where: { id: queueId, userId } }),

  /**
   * Same, locking the row FOR NO KEY UPDATE until `transaction` ends. Claims take
   * the same lock, so a status change and a claim never interleave.
   */
  findForUserLocked: ({ queueId, userId }, { transaction }) =>
    Queue.findOne({
      where: { id: queueId, userId },
      lock: transaction.LOCK.NO_KEY_UPDATE,
      transaction,
    }),

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

  update: (queue, changes, { transaction } = {}) => queue.update(changes, { transaction }),
};
