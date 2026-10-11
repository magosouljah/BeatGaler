#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_RESERVED_PORTS = Object.freeze([4000, 4011, 4013, 1421]);
const FORBIDDEN_PATH_MARKERS = Object.freeze(['.billing-e2e', '.env.stage1']);

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for isolated STEP15.`);
  return value;
}

function integer(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function assertCleanPath(value, name, runId) {
  const normalized = String(value).replaceAll('\\', '/').toLowerCase();
  for (const marker of FORBIDDEN_PATH_MARKERS) {
    if (normalized.includes(marker)) throw new Error(`${name} must not use ${marker}.`);
  }
  if (!normalized.includes(runId.toLowerCase())) {
    throw new Error(`${name} must include STEP15_RUN_ID so artifacts cannot collide.`);
  }
  return value;
}

function reservedPorts(env) {
  const extra = String(env.STEP15_RESERVED_PORTS || '').split(',').map(value => value.trim()).filter(Boolean)
    .map(value => integer(value, 'STEP15_RESERVED_PORTS entry', 1, 65535));
  return new Set([...DEFAULT_RESERVED_PORTS, ...extra]);
}

export function validateStep15Env(env = process.env) {
  const runId = required(env, 'STEP15_RUN_ID');
  if (!/^step15[-_][a-z0-9][a-z0-9_-]{2,63}$/i.test(runId)) {
    throw new Error('STEP15_RUN_ID must start with step15- or step15_ and contain only letters, digits, _ or -.');
  }
  const cloudPort = integer(required(env, 'STEP15_CLOUD_PORT'), 'STEP15_CLOUD_PORT', 1024, 65535);
  const webPort = integer(required(env, 'STEP15_WEB_PORT'), 'STEP15_WEB_PORT', 1024, 65535);
  if (cloudPort === webPort) throw new Error('STEP15 cloud and Web ports must be distinct.');
  const reserved = reservedPorts(env);
  if (reserved.has(cloudPort) || reserved.has(webPort)) {
    throw new Error(`STEP15 ports collide with a reserved STEP14/Stage1 port (${cloudPort}/${webPort}).`);
  }

  const databaseUrlText = required(env, 'STEP15_DATABASE_URL');
  let databaseUrl;
  try { databaseUrl = new URL(databaseUrlText); }
  catch { throw new Error('STEP15_DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('STEP15_DATABASE_URL must use postgres:// or postgresql://.');
  }
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''));
  if (!databaseName || !/step15/i.test(databaseName) || /(step14|billing|polar)/i.test(databaseName)) {
    throw new Error('STEP15 database name must contain step15 and must not identify STEP14/Billing/Polar state.');
  }

  const tempDir = assertCleanPath(required(env, 'STEP15_TEMP_DIR'), 'STEP15_TEMP_DIR', runId);
  const runDir = assertCleanPath(required(env, 'STEP15_RUN_DIR'), 'STEP15_RUN_DIR', runId);
  if (String(env.BEATGALER_PROJECT_UPLOAD_TEMP_DIR || '') !== tempDir) {
    throw new Error('BEATGALER_PROJECT_UPLOAD_TEMP_DIR must exactly equal STEP15_TEMP_DIR.');
  }

  if (String(env.BEATGALER_HTTP_REQUEST_TIMEOUT_MS || '') !== '1800000' ||
      String(env.BEATGALER_HTTP_SOCKET_TIMEOUT_MS || '') !== '1800000') {
    throw new Error('STEP15 Cloud must explicitly use 1800000ms request and socket timeouts.');
  }
  const maxConcurrent = integer(required(env, 'BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT'),
    'BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT', 1, 8);
  const tempBudgetBytes = integer(required(env, 'BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES'),
    'BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES', 1_900_000_000, 16_000_000_000);

  const inheritedForbidden = Object.keys(env).filter(key =>
    key.startsWith('BILLING_E2E_') || key === 'STAGE1_COHORT_ID' || key === 'STAGE1_COHORT_PASSWORD');
  if (inheritedForbidden.length) {
    throw new Error(`STEP15 shell inherited forbidden STEP14/Stage1 state: ${inheritedForbidden.sort().join(', ')}`);
  }

  const cloudUrl = String(env.STEP15_CLOUD_URL || '').trim();
  if (cloudUrl) {
    const expected = new Set([`http://127.0.0.1:${cloudPort}`, `http://localhost:${cloudPort}`]);
    if (!expected.has(cloudUrl.replace(/\/$/, ''))) {
      throw new Error('STEP15_CLOUD_URL must point to the dedicated local STEP15_CLOUD_PORT.');
    }
  }

  return Object.freeze({
    kind: 'STEP15_ISOLATED_ENV_GUARD',
    result: 'PASS',
    runId,
    cloudPort,
    webPort,
    databaseName,
    tempDir,
    runDir,
    maxConcurrent,
    tempBudgetBytes,
    reservedPorts: [...reserved].sort((a, b) => a - b),
  });
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  try { console.log(JSON.stringify(validateStep15Env(process.env), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ kind: 'STEP15_ISOLATED_ENV_GUARD', result: 'FAIL', error: error?.message || String(error) }, null, 2));
    process.exitCode = 2;
  }
}
