#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installed = process.argv.includes('--installed') || process.argv.includes('--full');
const full = process.argv.includes('--full');
const unknown = process.argv.slice(2).filter(arg => !['--installed', '--full'].includes(arg));
if (unknown.length) {
  console.error('usage: node scripts/step15-prep-suite.mjs [--installed|--full]');
  process.exit(64);
}

const steps = [
  { name: 'readonly-preflight', command: process.execPath, args: ['scripts/step15-readonly-preflight.mjs'] },
  { name: 'pure-node-contracts', command: process.execPath, args: ['--test',
    'cloud-server/tests/runtime-operability.test.cjs',
    'cloud-server/tests/project-upload-admission.test.cjs',
    'tests/step15-isolated-env-guard.test.mjs',
  ] },
  { name: 'nginx-ingress-contract', command: process.execPath,
    args: ['scripts/step15-project-ingress-smoke.mjs', ...(installed ? ['--require-nginx'] : [])] },
];

if (installed) {
  steps.push(
    { name: 'project-route-contract', command: process.execPath,
      args: ['--test', 'cloud-server/tests/project-upload-route.test.cjs'] },
    { name: 'project-route-smoke', command: process.execPath,
      args: ['cloud-server/scripts/step15-project-route-smoke.cjs'] },
    { name: 'project-proxy-route-smoke', command: process.execPath,
      args: ['cloud-server/scripts/step15-project-proxy-route-smoke.cjs', '--require-nginx'] },
  );
}
if (full) steps.push({ name: 'web-build', command: 'npm', args: ['run', 'build:web'] });

const results = [];
for (const step of steps) {
  const started = Date.now();
  console.log(`\n[STEP15 PREP] ${step.name}`);
  const run = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit', shell: false, env: { ...process.env } });
  const exitCode = Number.isInteger(run.status) ? run.status : 1;
  results.push({ name: step.name, result: exitCode === 0 ? 'PASS' : 'FAIL', exitCode, durationMs: Date.now() - started });
}

const failed = results.filter(item => item.result !== 'PASS');
console.log('\n' + JSON.stringify({
  kind: 'STEP15_PREP_SUITE',
  mode: full ? 'full' : installed ? 'installed' : 'static',
  result: failed.length ? 'FAIL' : 'PASS',
  steps: results,
  externalMutableServicesUsed: false,
  note: 'installed/full still use only local repo/runtime checks; they do not connect to PostgreSQL, Telegram or Polar unless a child command is changed in the future.'
}, null, 2));
if (failed.length) process.exitCode = 2;
