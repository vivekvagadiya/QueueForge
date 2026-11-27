import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().trim().min(1).optional(),
  REDIS_URL: z.string().trim().min(1).optional(),
  CORS_ORIGIN: z.string().trim().min(1).default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().trim().min(1).default('1h'),
  JWT_ISSUER: z.string().trim().min(1).default('queueforge-api'),

  // Redis Streams
  STREAM_PREFIX: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .default('queueforge'),

  // Outbox publisher
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  // A PROCESSING claim older than this is treated as abandoned and re-claimed.
  // Must comfortably exceed the time to publish one batch.
  OUTBOX_CLAIM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().min(1).default(1000),
  OUTBOX_RETRY_MAX_MS: z.coerce.number().int().min(1).default(60_000),

  // Workers
  WORKER_NAME: z.string().trim().min(1).max(100).optional(),
  CONSUMER_GROUP: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .default('queueforge-workers'),
  // Comma-separated queue IDs, or "*" for every non-archived queue.
  WORKER_QUEUES: z.string().trim().min(1).default('*'),
  WORKER_QUEUE_REFRESH_MS: z.coerce.number().int().min(100).default(10_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(5),
  WORKER_BLOCK_MS: z.coerce.number().int().min(10).max(60_000).default(2000),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(20_000),
  // How often a running job's lease is extended. Defaults to WORKER_LEASE_MS / 3.
  WORKER_LEASE_RENEW_MS: z.coerce.number().int().min(100).optional(),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(100).default(5000),
  // Stream entries pending longer than this in any consumer are taken over (XAUTOCLAIM).
  WORKER_PENDING_IDLE_MS: z.coerce.number().int().min(1000).default(60_000),
  WORKER_PENDING_CHECK_MS: z.coerce.number().int().min(100).default(15_000),
  JOB_RETRY_BASE_MS: z.coerce.number().int().min(1).default(1000),
  JOB_RETRY_MAX_MS: z.coerce.number().int().min(1).default(300_000),

  // Recovery process
  RECOVERY_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  // A worker with no heartbeat for this long is marked UNHEALTHY.
  WORKER_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
}).superRefine((cfg, ctx) => {
  if (cfg.WORKER_LEASE_RENEW_MS !== undefined && cfg.WORKER_LEASE_RENEW_MS >= cfg.WORKER_LEASE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WORKER_LEASE_RENEW_MS'],
      message: 'must be shorter than WORKER_LEASE_MS',
    });
  }
  if (cfg.WORKER_HEARTBEAT_MS >= cfg.WORKER_HEARTBEAT_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WORKER_HEARTBEAT_MS'],
      message: 'must be shorter than WORKER_HEARTBEAT_TIMEOUT_MS',
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid API environment configuration: ${details}`);
}

const parseCorsOrigin = (originValue) => {
  if (originValue === '*') {
    return '*';
  }

  const origins = originValue
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length === 1 ? origins[0] : origins;
};

export const env = Object.freeze({
  ...parsed.data,
  corsOrigin: parseCorsOrigin(parsed.data.CORS_ORIGIN),
});
