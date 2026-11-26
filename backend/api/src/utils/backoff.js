/**
 * Exponential backoff with jitter: a random delay in [d/2, d], where
 * d = min(maxMs, baseMs * 2^(attempt - 1)). The jitter spreads retries out so
 * many failures at once don't all retry at the same instant.
 */
export const retryDelayMs = (attempt, { baseMs, maxMs }) => {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
};
