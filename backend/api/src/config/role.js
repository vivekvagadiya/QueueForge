import path from 'node:path';

/**
 * Which QueueForge process this is, from the entry script that started it.
 * Used to label logs and metrics; anything else (migrations, tests) is "cli".
 */
const ROLES = {
  'server.js': 'api',
  'publisher.js': 'publisher',
  'worker.js': 'worker',
  'recovery.js': 'recovery',
};

export const processRole = ROLES[path.basename(process.argv[1] ?? '')] ?? 'cli';
