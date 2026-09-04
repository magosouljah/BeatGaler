'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseLegacyJson, snapshotManifest, planLegacyImport, stableStringify, sha256 } = require('./legacy-import-plan');

const SOURCE_FILES = Object.freeze(['accounts-data.json', 'cloud-data.json']);

function safeReason(error) {
  const text = String(error?.message || error || 'validation failed');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 512);
}

function exactSources({ authRaw, persistentRaw }) {
  return {
    'accounts-data.json': String(authRaw),
    'cloud-data.json': String(persistentRaw),
  };
}

function buildBundleDescriptor({ authRaw, persistentRaw }) {
  const sources = exactSources({ authRaw, persistentRaw });
  const snapshot = snapshotManifest(sources);
  const auth = parseLegacyJson(sources['accounts-data.json'], 'accounts-data.json');
  const persistent = parseLegacyJson(sources['cloud-data.json'], 'cloud-data.json');
  const plan = planLegacyImport(auth, persistent);
  const descriptor = {
    version: 1,
    status: 'SEALED',
    snapshot_sha256: snapshot.manifest_sha256,
    plan_sha256: plan.plan_sha256,
    files: snapshot.files,
  };
  return Object.freeze({
    sources,
    snapshot,
    plan,
    descriptor: Object.freeze({ ...descriptor, bundle_sha256: sha256(stableStringify(descriptor)) }),
  });
}

function createExclusiveDirectory(targetDir) {
  fs.mkdirSync(targetDir, { recursive: false, mode: 0o700 });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function writeRaw(filePath, raw) {
  fs.writeFileSync(filePath, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function createCutoverSnapshotBundle(targetDir, { authRaw, persistentRaw }) {
  createExclusiveDirectory(targetDir);
  const sources = exactSources({ authRaw, persistentRaw });
  for (const name of SOURCE_FILES) writeRaw(path.join(targetDir, name), sources[name]);

  try {
    const built = buildBundleDescriptor({ authRaw, persistentRaw });
    writeJson(path.join(targetDir, 'manifest.json'), built.descriptor);
    fs.writeFileSync(path.join(targetDir, 'SEALED'), `${built.descriptor.bundle_sha256}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return Object.freeze({ status: 'SEALED', ...built.descriptor, directory: targetDir });
  } catch (error) {
    const quarantine = Object.freeze({
      version: 1,
      status: 'QUARANTINED',
      reason: safeReason(error),
      snapshot: snapshotManifest(sources),
    });
    writeJson(path.join(targetDir, 'QUARANTINED.json'), quarantine);
    throw new Error(`Cutover snapshot quarantined: ${quarantine.reason}`);
  }
}

function verifyCutoverSnapshotBundle(targetDir) {
  const quarantinePath = path.join(targetDir, 'QUARANTINED.json');
  if (fs.existsSync(quarantinePath)) throw new Error('Cutover snapshot bundle is quarantined.');

  const manifestPath = path.join(targetDir, 'manifest.json');
  const sealPath = path.join(targetDir, 'SEALED');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(sealPath)) throw new Error('Cutover snapshot bundle is not sealed.');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.version !== 1 || manifest?.status !== 'SEALED') throw new Error('Cutover snapshot manifest is invalid.');
  const recordedBundleSha = String(manifest.bundle_sha256 || '');
  const descriptor = { ...manifest };
  delete descriptor.bundle_sha256;
  const computedBundleSha = sha256(stableStringify(descriptor));
  const seal = fs.readFileSync(sealPath, 'utf8').trim();
  if (recordedBundleSha !== computedBundleSha || seal !== computedBundleSha) throw new Error('Cutover snapshot bundle seal mismatch.');

  const sources = {};
  for (const name of SOURCE_FILES) sources[name] = fs.readFileSync(path.join(targetDir, name), 'utf8');
  const snapshot = snapshotManifest(sources);
  if (snapshot.manifest_sha256 !== manifest.snapshot_sha256) throw new Error('Cutover snapshot source files do not match the sealed manifest.');
  const expectedFiles = JSON.stringify(snapshot.files);
  if (JSON.stringify(manifest.files) !== expectedFiles) throw new Error('Cutover snapshot file metadata does not match the sealed sources.');

  const auth = parseLegacyJson(sources['accounts-data.json'], 'accounts-data.json');
  const persistent = parseLegacyJson(sources['cloud-data.json'], 'cloud-data.json');
  const plan = planLegacyImport(auth, persistent);
  if (plan.plan_sha256 !== manifest.plan_sha256) throw new Error('Cutover snapshot import plan does not match the sealed manifest.');

  return Object.freeze({
    status: 'SEALED',
    directory: targetDir,
    bundleSha256: computedBundleSha,
    snapshot,
    plan,
    authRaw: sources['accounts-data.json'],
    persistentRaw: sources['cloud-data.json'],
  });
}

module.exports = {
  SOURCE_FILES,
  buildBundleDescriptor,
  createCutoverSnapshotBundle,
  verifyCutoverSnapshotBundle,
};
