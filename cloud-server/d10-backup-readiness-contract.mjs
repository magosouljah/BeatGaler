#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const contract = Object.freeze({
  id: 'D10.1-backup-readiness-v1',
  coverage: [
    { component: 'control-config', authority: 'versioned deployment config + secret references', backup: 'versioned config snapshot; secret values remain provider-managed and excluded from artifact payloads' },
    { component: 'index', authority: 'PostgreSQL control/index state', backup: 'encrypted provider backup/WAL/PITR plus isolated restore evidence already accepted' },
    { component: 'media', authority: 'provider object storage reached device↔provider direct', backup: 'provider-side object durability/versioning or replication policy; manifest records object inventory/checksums without relaying media through Galer Cloud' },
  ],
  offProvider: {
    requirement: 'at least one backup copy outside the primary provider/account failure domain',
    dryRun: 'writes only a manifest to a caller-supplied local directory; this validates packaging/checksums but does NOT prove a real off-provider copy',
    externalProofRequired: true,
  },
  backupFailureAlert: {
    condition: 'backup job exits non-zero OR freshness exceeds configured RPO window',
    routeEnv: 'BACKUP_FAILURE_ALERT_ROUTE',
    requiredFields: ['event', 'severity', 'component', 'reason', 'observedAt', 'route'],
  },
});

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function validateContract() {
  const components = new Set(contract.coverage.map((x) => x.component));
  for (const required of ['control-config', 'index', 'media']) {
    if (!components.has(required)) throw new Error(`missing backup coverage component: ${required}`);
  }
  if (!contract.offProvider.externalProofRequired) throw new Error('off-provider requirement must remain external-proof gated');
  if (contract.backupFailureAlert.routeEnv !== 'BACKUP_FAILURE_ALERT_ROUTE') throw new Error('backup failure route contract drift');
  return true;
}

function buildFailureAlert({ component = 'index', reason = 'simulated-backup-failure', route = process.env.BACKUP_FAILURE_ALERT_ROUTE ?? 'UNCONFIGURED' } = {}) {
  return {
    event: 'backup.failure',
    severity: 'critical',
    component,
    reason,
    observedAt: new Date(0).toISOString(),
    route,
  };
}

function validateFailureAlert(alert) {
  for (const key of contract.backupFailureAlert.requiredFields) {
    if (!alert[key]) throw new Error(`backup failure alert missing field: ${key}`);
  }
  if (alert.event !== 'backup.failure' || alert.severity !== 'critical') throw new Error('backup failure alert taxonomy mismatch');
  return alert.route !== 'UNCONFIGURED';
}

async function writeDryRunManifest(dir) {
  validateContract();
  const payload = {
    contractId: contract.id,
    coverage: contract.coverage,
    generatedAt: new Date(0).toISOString(),
    proof: 'LOCAL_DRY_RUN_ONLY',
    externalProofSatisfied: false,
  };
  const canonical = JSON.stringify(payload, null, 2) + '\n';
  const outDir = resolve(dir);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'd10-backup-manifest.json'), canonical, 'utf8');
  await writeFile(resolve(outDir, 'd10-backup-manifest.sha256'), `${sha256(canonical)}  d10-backup-manifest.json\n`, 'utf8');
  return { outDir, sha256: sha256(canonical), externalProofSatisfied: false };
}

async function selfTest() {
  validateContract();
  const configured = buildFailureAlert({ route: 'ops://backup-failures' });
  if (!validateFailureAlert(configured)) throw new Error('configured backup failure route rejected');
  const unconfigured = buildFailureAlert();
  if (validateFailureAlert(unconfigured)) throw new Error('unconfigured route must remain pending');
  const dir = process.env.D10_DRY_RUN_DIR ?? '.tmp/d10-backup-readiness';
  const manifest = await writeDryRunManifest(dir);
  if (manifest.externalProofSatisfied !== false) throw new Error('local dry-run must not claim external proof');
  console.log(JSON.stringify({
    status: 'PASS_LOCAL_CONTRACT',
    coverage: contract.coverage.map((x) => x.component),
    backupFailureAlert: 'PASS_CONDITION_AND_ROUTE_VALIDATION',
    offProvider: 'PENDING_EXTERNAL_PROOF',
    manifest,
  }, null, 2));
}

const [command, arg] = process.argv.slice(2);
if (command === '--self-test') {
  await selfTest();
} else if (command === '--dry-run') {
  console.log(JSON.stringify(await writeDryRunManifest(arg ?? '.tmp/d10-backup-readiness'), null, 2));
} else if (command === '--simulate-backup-failure') {
  const alert = buildFailureAlert({ route: process.env.BACKUP_FAILURE_ALERT_ROUTE ?? 'UNCONFIGURED' });
  const routed = validateFailureAlert(alert);
  console.log(JSON.stringify({ routed, alert }, null, 2));
  if (!routed) process.exitCode = 2;
} else if (command === '--contract') {
  validateContract();
  console.log(JSON.stringify(contract, null, 2));
} else {
  console.error('usage: node cloud-server/d10-backup-readiness-contract.mjs --self-test | --dry-run [dir] | --simulate-backup-failure | --contract');
  process.exitCode = 64;
}
