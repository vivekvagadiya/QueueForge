import { z } from 'zod';
import { QUEUE_STATUSES } from '../models/queue.model.js';
import { paginationQuery, statusListQuery, uuid } from './common.validator.js';

const queueName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/,
    'Name must be 1-100 chars: letters, digits, "_", ".", ":", "-", starting with a letter or digit'
  );

export const defaultJobOptionsSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(100).optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
  })
  .strict();

export const queueIdParams = z.object({ queueId: uuid });

export const createQueueSchema = {
  body: z
    .object({
      name: queueName,
      description: z.string().trim().max(1000).nullish(),
      concurrency: z.number().int().min(1).max(1000).optional(),
      defaultJobOptions: defaultJobOptionsSchema.optional(),
    })
    .strict(),
};

export const listQueuesSchema = {
  query: paginationQuery.extend({
    status: statusListQuery(QUEUE_STATUSES),
    // Case-insensitive substring match on the queue name.
    search: z.string().trim().max(100).optional().transform((v) => v || undefined),
  }),
};

export const getQueueSchema = { params: queueIdParams };

export const updateQueueSchema = {
  params: queueIdParams,
  body: z
    .object({
      name: queueName.optional(),
      description: z.string().trim().max(1000).nullish(),
      status: z.enum(QUEUE_STATUSES).optional(),
      concurrency: z.number().int().min(1).max(1000).optional(),
      defaultJobOptions: defaultJobOptionsSchema.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'At least one field must be provided'),
};
