import { User } from './user.model.js';
import { Queue } from './queue.model.js';
import { Job } from './job.model.js';
import { Worker } from './worker.model.js';
import { JobAttempt } from './jobAttempt.model.js';
import { OutboxEvent } from './outboxEvent.model.js';

const models = { User, Queue, Job, Worker, JobAttempt, OutboxEvent };
let initialized = false;

/**
 * Registers all models and associations on the given connection.
 * Schema is owned by migrations; never call sequelize.sync() for schema changes.
 */
export const initModels = (sequelize) => {
  if (initialized) {
    return models;
  }

  Object.values(models).forEach((model) => model.initModel(sequelize));
  Object.values(models).forEach((model) => model.associate?.(models));
  initialized = true;

  return models;
};

export { User, Queue, Job, Worker, JobAttempt, OutboxEvent };
