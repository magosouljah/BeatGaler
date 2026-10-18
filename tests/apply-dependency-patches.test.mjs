import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/apply-dependency-patches.mjs', import.meta.url));

test('production-only install omits the build-time patch tool', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'beatgaler-prod-patches-'));
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd, encoding: 'utf8', env: { ...process.env, npm_config_omit: 'dev' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping build-time dependency patches/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('full install fails closed if patch-package is absent', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'beatgaler-full-patches-'));
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd, encoding: 'utf8', env: { ...process.env, npm_config_omit: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /patch-package is required/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
