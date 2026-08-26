'use strict';

const fs = require('fs');
const path = require('path');
const { parseLegacyJson, snapshotManifest, planLegacyImport } = require('../legacy-import-plan.js');

function resolveInput(value, fallback) {
  return path.resolve(process.cwd(), value || fallback);
}

const authPath = resolveInput(process.argv[2], 'accounts-data.json');
const dataPath = resolveInput(process.argv[3], 'cloud-data.json');

const authRaw = fs.readFileSync(authPath, 'utf8');
const dataRaw = fs.readFileSync(dataPath, 'utf8');
const authData = parseLegacyJson(authRaw, path.basename(authPath));
const persistentData = parseLegacyJson(dataRaw, path.basename(dataPath));
const manifest = snapshotManifest({
  [path.basename(authPath)]: authRaw,
  [path.basename(dataPath)]: dataRaw,
});
const plan = planLegacyImport(authData, persistentData);

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: 'dry-run',
  manifest,
  counts: plan.counts,
  plan_sha256: plan.plan_sha256,
}, null, 2)}\n`);
