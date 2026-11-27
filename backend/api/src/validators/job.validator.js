import { z } from 'zod';
import { JOB_STATUSES } from '../models/job.model.js';
import { jsonObject, paginationQuery, statusListQuery, uuid } from './common.validator.js';
import { queueIdParams } from './queue.validator.js';

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

export const idempotencyKey = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7E]+$/, 'Idempotency key must be printable ASCII without spaces');

export const createJobSchema = {
  params: queueIdParams,
  body: z
    .object({
      name: z.string().trim().min(1).max(255),
      payload: jsonObject.default({}),
      priority: z.number().int().min(-1000).max(1000).optional(),
      maxAttempts: z.number().int().min(1).max(100).optional(),
      delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional(),
      scheduledAt: z.string().datetime({ offset: true }).optional(),
      idempotencyKey: idempotencyKey.optional(),
    })
    .strict()
    .refine((body) => !(body.delayMs !== undefined && body.scheduledAt !== undefined), {
      message: 'Provide either delayMs or scheduledAt, not both',
      path: ['scheduledAt'],
    }),
};

export const listJobsSchema = {
  params: queueIdParams,
  query: paginationQuery.extend({
    status: statusListQuery(JOB_STATUSES),
    // Job name contains (case-insensitive), or an exact job ID.
    search: z.string().trim().max(255).optional().transform((v) => v || undefined),
  }),
};

export const getJobSchema = { params: z.object({ jobId: uuid }) };
