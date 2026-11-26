import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(255);

export const registerSchema = {
  body: z
    .object({
      name: z.string().trim().min(1).max(100),
      email,
      password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    })
    .strict(),
};

export const loginSchema = {
  body: z
    .object({
      email,
      // No length rules on login: don't reveal password policy, just verify.
      password: z.string().min(1).max(128),
    })
    .strict(),
};
