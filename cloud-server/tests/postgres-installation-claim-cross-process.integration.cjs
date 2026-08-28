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

function firstLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline >= 0) resolve(stdout.slice(0, newline).trim());
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`claim child exited ${code}: ${stderr}`));
      else if (!stdout.includes('\n')) reject(new Error(`claim child exited without result: ${stderr}`));
    });
  });
}

function exited(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`claim child exited ${code}: ${stderr}`)));
  });
}

async function parentMode() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for cross-process authorization test');
  const installationId = `d6-cross-process-${process.pid}`;

  const holder = spawnClaim({ installationId, hold: true });
  assert.equal(await firstLine(holder), 'ACQUIRED', 'process A must acquire the installation claim');

  const contender = spawnClaim({ installationId });
  assert.equal(await firstLine(contender), 'BLOCKED', 'process B must be denied while process A holds the same DB advisory lock');
  await exited(contender);

  const independent = spawnClaim({ installationId: `${installationId}-other` });
  assert.equal(await firstLine(independent), 'ACQUIRED', 'an unrelated installation may proceed concurrently');
  await exited(independent);

  const holderExit = exited(holder);
  holder.stdin.write('release\n');
  holder.stdin.end();
  await holderExit;

  const afterRelease = spawnClaim({ installationId });
  assert.equal(await firstLine(afterRelease), 'ACQUIRED', 'claim must become available to another process after response-scoped release');
  await exited(afterRelease);

  console.log('PASS real PostgreSQL cross-process installation claim atomicity');
}

(process.env.D6_CLAIM_CHILD === 'true' ? childMode() : parentMode()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
