'use strict';

function requireKey(key, label) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`${label} must be exactly 32 bytes.`);
  }
  return key;
}

function normalizeSecretKeyring(config) {
  if (!config || typeof config !== 'object') throw new Error('Secret key configuration is required.');

  // Already-normalized keyrings may cross provider/runtime boundaries. Revalidate
  // rather than trusting object shape so normalization remains an idempotent
  // security boundary.
  if (typeof config.resolveKey === 'function' && Buffer.isBuffer(config.encryptKey) && Array.isArray(config.availableVersions)) {
    const activeKeyVersion = Number(config.activeKeyVersion);
    if (!Number.isInteger(activeKeyVersion) || activeKeyVersion <= 0) {
      throw new Error('Secret keyring activeKeyVersion must be a positive integer.');
    }
    requireKey(config.encryptKey, `Secret key v${activeKeyVersion}`);
    const versions = [...new Set(config.availableVersions.map(Number))].sort((a, b) => a - b);
    if (!versions.length || versions.some(version => !Number.isInteger(version) || version <= 0)) {
      throw new Error('Secret keyring availableVersions must contain positive integers.');
    }
    if (!versions.includes(activeKeyVersion)) {
      throw new Error(`Active secret key version ${activeKeyVersion} is unavailable.`);
    }
    for (const version of versions) requireKey(config.resolveKey(version), `Secret key v${version}`);
    const activeResolved = config.resolveKey(activeKeyVersion);
    if (!activeResolved.equals(config.encryptKey)) {
      throw new Error(`Active secret key version ${activeKeyVersion} does not match encryptKey.`);
    }
    return Object.freeze({
      activeKeyVersion,
      encryptKey: config.encryptKey,
      resolveKey(requestedVersion) {
        const version = Number(requestedVersion);
        if (!versions.includes(version)) throw new Error(`Envelope key version ${requestedVersion} is unavailable.`);
        return requireKey(config.resolveKey(version), `Secret key v${version}`);
      },
      availableVersions: Object.freeze(versions),
    });
  }

  // Backward-compatible single-key form used by CI/development today.
  if (Buffer.isBuffer(config.key)) {
    const version = Number(config.keyVersion);
    if (!Number.isInteger(version) || version <= 0) throw new Error('Secret key version must be a positive integer.');
    const key = requireKey(config.key, `Secret key v${version}`);
    return Object.freeze({
      activeKeyVersion: version,
      encryptKey: key,
      resolveKey(requestedVersion) {
        if (Number(requestedVersion) !== version) throw new Error(`Envelope key version ${requestedVersion} is unavailable.`);
        return key;
      },
      availableVersions: Object.freeze([version]),
    });
  }

  const activeKeyVersion = Number(config.activeKeyVersion);
  if (!Number.isInteger(activeKeyVersion) || activeKeyVersion <= 0) {
    throw new Error('Secret keyring activeKeyVersion must be a positive integer.');
  }

  const entries = config.keys instanceof Map
    ? [...config.keys.entries()]
    : Object.entries(config.keys || {});
  if (!entries.length) throw new Error('Secret keyring requires at least one key.');

  const keys = new Map();
  for (const [versionRaw, keyRaw] of entries) {
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version <= 0) throw new Error(`Invalid secret key version: ${versionRaw}`);
    if (keys.has(version)) throw new Error(`Duplicate secret key version: ${version}`);
    keys.set(version, requireKey(keyRaw, `Secret key v${version}`));
  }
  if (!keys.has(activeKeyVersion)) throw new Error(`Active secret key version ${activeKeyVersion} is unavailable.`);

  return Object.freeze({
    activeKeyVersion,
    encryptKey: keys.get(activeKeyVersion),
    resolveKey(requestedVersion) {
      const version = Number(requestedVersion);
      const key = keys.get(version);
      if (!key) throw new Error(`Envelope key version ${requestedVersion} is unavailable.`);
      return key;
    },
    availableVersions: Object.freeze([...keys.keys()].sort((a, b) => a - b)),
  });
}

module.exports = { normalizeSecretKeyring };
