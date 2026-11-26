import { z } from 'zod';

export const uuid = z.string().uuid('Must be a valid UUID');

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Accepts `?status=A` or `?status=A,B` and returns a de-duplicated array. */
export const statusListQuery = (allowed) =>
  z
    .string()
    .trim()
    .transform((value) => [...new Set(value.split(',').map((s) => s.trim().toUpperCase()))])
    .pipe(z.array(z.enum(allowed)).min(1))
    .optional();

/** JSON object payloads (not arrays or scalars). */
export const jsonObject = z.record(z.string(), z.unknown());
