import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const tests = [
  'cloud-server/tests/direct-vault-assignment.test.cjs',
  'cloud-server/tests/direct-persistent-session-runtime.test.cjs',
  'cloud-server/tests/direct-persistent-cleanup.test.cjs',
  'cloud-server/tests/stage1-multi-account-concurrency.test.cjs',
];

for (const test of tests) {
  console.log(`\n[stage1] ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, test)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('\nPASS Stage 1 multi-account test suite');
