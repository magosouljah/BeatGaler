import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTempStorage } from '../scripts/v1-temp-storage-check.mjs';

const reader = ({ free = 5000n, entries = [] } = {}) => ({
  lstatSync: () => ({ isDirectory: () => true }),
  statfsSync: () => ({ bavail: free, bsize: 1n }),
  readdirSync: () => entries.map(({ name }) => ({ name, isFile: () => true })),
  statSync: path => ({ mtimeMs: entries.find(entry => path.endsWith(entry.name)).mtimeMs }),
});

test('temp storage probe passes only with budget and no stale files', () => {
  const result = assessTempStorage({ directory: '/synthetic/uploads', budgetBytes: 1000,
    now: 10_000_000, reader: reader({ entries: [{ name: 'active', mtimeMs: 9_999_000 }] }) });
  assert.equal(result.result, 'PASS');
  assert.equal(result.alertDeliveryProven, false);
});

test('temp storage probe detects low free space and stale upload files', () => {
  const lowDisk = assessTempStorage({ directory: '/synthetic/uploads', budgetBytes: 1000,
    reader: reader({ free: 999n }) });
  assert.equal(lowDisk.result, 'ALERT');
  const stale = assessTempStorage({ directory: '/synthetic/uploads', budgetBytes: 1000,
    now: 10_000_000, reader: reader({ entries: [{ name: 'orphan', mtimeMs: 1_000 }] }) });
  assert.equal(stale.result, 'ALERT');
  assert.equal(stale.staleCount, 1);
});

test('temp storage probe rejects symlink directory', () => {
  assert.throws(() => assessTempStorage({ directory: '/synthetic/link', budgetBytes: 1000,
    reader: { lstatSync: () => ({ isDirectory: () => false }) } }), /not a symlink/);
});

test('CLI failure does not print a configured path', () => {
  const script = fileURLToPath(new URL('../scripts/v1-temp-storage-check.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
    ...process.env, BEATGALER_PROJECT_UPLOAD_TEMP_DIR: '/missing/private-marker',
    BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES: '1000',
  } });
  assert.equal(result.status, 2);
  assert.equal(result.stderr.includes('private-marker'), false);
  assert.match(result.stderr, /TEMP_STORAGE_PROBE_UNAVAILABLE/);
});
