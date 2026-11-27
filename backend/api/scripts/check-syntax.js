import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * `npm run check:syntax`: runs `node --check` on every .js file under src/,
 * test/ and scripts/. The backend has no ESLint config yet; this catches parse errors
 * in CI without executing anything.
 */
const ROOTS = ['src', 'test', 'scripts'];

const listJs = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listJs(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const files = ROOTS.flatMap((root) => listJs(root));
const failures = files.filter((file) => {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  return result.status !== 0;
});

console.log(`Checked ${files.length} files; ${failures.length} with syntax errors.`);
process.exit(failures.length === 0 ? 0 : 1);
