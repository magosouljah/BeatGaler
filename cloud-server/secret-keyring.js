'use strict';

function requireKey(key, label) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`${label} must be exactly 32 bytes.`);
  }
  return key;
}

function normalizeSecretKeyring(config) {
  if (!config || typeof config !== 'object') throw new Error('Secret key configuration is required.');

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
