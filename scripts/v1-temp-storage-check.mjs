#!/usr/bin/env node
// Read-only local probe. Schedule it externally and route nonzero results to on-call.
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { alertRoute } = require('../cloud-server/operations-observability.js');
const MAX_ENTRIES = 10_000;
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

export function assessTempStorage({ directory, budgetBytes, staleMs = DEFAULT_STALE_MS,
  now = Date.now(), reader = fs, env = process.env } = {}) {
  if (!directory || !Number.isSafeInteger(budgetBytes) || budgetBytes <= 0 ||
      !Number.isSafeInteger(staleMs) || staleMs < 60_000) throw new Error('Invalid temp storage probe configuration.');
  if (!reader.lstatSync(directory).isDirectory()) throw new Error('Temp storage path must be a directory, not a symlink.');
  const stat = reader.statfsSync(directory, { bigint: true });
  const freeBytes = stat.bavail * stat.bsize;
  const entries = reader.readdirSync(directory, { withFileTypes: true });
  let staleCount = 0;
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    if (!entry.isFile()) continue;
    const details = reader.statSync(resolve(directory, entry.name));
    if (now - details.mtimeMs >= staleMs) staleCount += 1;
  }
  const pressure = freeBytes < BigInt(budgetBytes) || staleCount > 0 || entries.length > MAX_ENTRIES;
  return { kind: 'V1_TEMP_STORAGE_CHECK', result: pressure ? 'ALERT' : 'PASS',
    condition: 'temp_storage_pressure', freeBytes: freeBytes.toString(), budgetBytes,
    entryCount: entries.length, staleCount, scanLimitReached: entries.length > MAX_ENTRIES,
    routeConfigured: alertRoute('temp_storage_pressure', env).routable, alertDeliveryProven: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = assessTempStorage({ directory: process.env.BEATGALER_PROJECT_UPLOAD_TEMP_DIR,
      budgetBytes: Number(process.env.BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES) });
    console.log(JSON.stringify(result));
    if (result.result !== 'PASS') process.exitCode = 2;
  } catch (_) {
    console.error(JSON.stringify({ kind: 'V1_TEMP_STORAGE_CHECK', result: 'FAIL', reason: 'TEMP_STORAGE_PROBE_UNAVAILABLE' }));
    process.exitCode = 2;
  }
}
