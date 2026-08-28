'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

async function childMode() {
  const { Pool } = require('pg');
  const { createPostgresInstallationClaimCoordinator } = require('../postgres-installation-claim-coordinator');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1 });
  const coordinator = createPostgresInstallationClaimCoordinator(pool);
  const release = await coordinator.tryAcquire(process.env.D6_INSTALLATION_ID);
  if (!release) {
    process.stdout.write('BLOCKED\n');
    await pool.end();
    return;
  }

  process.stdout.write('ACQUIRED\n');
  if (process.env.D6_HOLD_LOCK === 'true') {
    await new Promise((resolve, reject) => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', chunk => {
        if (String(chunk).trim() === 'release') resolve();
        else reject(new Error('unexpected release command'));
      });
      process.stdin.once('error', reject);
    });
  }
  await release();
  await pool.end();
}

function spawnClaim({ installationId, hold = false }) {
  return spawn(process.execPath, [__filename], {
    env: {
      ...process.env,
      D6_CLAIM_CHILD: 'true',
      D6_INSTALLATION_ID: installationId,
      D6_HOLD_LOCK: hold ? 'true' : 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function observe(child) {
  let stdout = '';
  let stderr = '';
  let lineSettled = false;
  let resolveLine;
  let rejectLine;
  const line = new Promise((resolve, reject) => { resolveLine = resolve; rejectLine = reject; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', error => {
      if (!lineSettled) { lineSettled = true; rejectLine(error); }
      reject(error);
    });
    child.once('exit', code => {
      if (code !== 0) {
        const error = new Error(`claim child exited ${code}: ${stderr}`);
        if (!lineSettled) { lineSettled = true; rejectLine(error); }
        reject(error);
        return;
      }
      if (!lineSettled) {
        const error = new Error(`claim child exited without result: ${stderr}`);
        lineSettled = true;
        rejectLine(error);
        reject(error);
        return;
      }
      resolve();
    });
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (!lineSettled && newline >= 0) {
      lineSettled = true;
      resolveLine(stdout.slice(0, newline).trim());
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { line, exit };
}

async function parentMode() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for cross-process authorization test');
  const installationId = `d6-cross-process-${process.pid}`;

  const holder = spawnClaim({ installationId, hold: true });
  const holderObserved = observe(holder);
  assert.equal(await holderObserved.line, 'ACQUIRED', 'process A must acquire the installation claim');

  const contender = spawnClaim({ installationId });
  const contenderObserved = observe(contender);
  assert.equal(await contenderObserved.line, 'BLOCKED', 'process B must be denied while process A holds the same DB advisory lock');
  await contenderObserved.exit;

  const independent = spawnClaim({ installationId: `${installationId}-other` });
  const independentObserved = observe(independent);
  assert.equal(await independentObserved.line, 'ACQUIRED', 'an unrelated installation may proceed concurrently');
  await independentObserved.exit;

  holder.stdin.write('release\n');
  holder.stdin.end();
  await holderObserved.exit;

  const afterRelease = spawnClaim({ installationId });
  const afterReleaseObserved = observe(afterRelease);
  assert.equal(await afterReleaseObserved.line, 'ACQUIRED', 'claim must become available to another process after response-scoped release');
  await afterReleaseObserved.exit;

  console.log('PASS real PostgreSQL cross-process installation claim atomicity');
}

(process.env.D6_CLAIM_CHILD === 'true' ? childMode() : parentMode()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
