'use strict';

const { sha256String: sha256 } = require('./auth-helpers');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.authority-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function installLifecyclePasswordAuthority(runtime) {
  if (!runtime?.api || runtime.__beatgalerPasswordAuthoritySyncInstalled) return runtime;
  runtime.__beatgalerPasswordAuthoritySyncInstalled = true;
  const state = runtime.api.state.stateSnapshot();
  const stateFile = runtime.api.state.stateFile;

  // After a restart the durable accounts snapshot already carries the reset
  // password authority. The compatibility override is no longer needed.
  let startupChanged = false;
  const startup = runtime.api.state.accountsSnapshot();
  for (const [userId, override] of Object.entries(state.password_overrides || {})) {
    const user = startup.users.find(row => String(row?.id || '') === String(userId));
    if (user && String(user.passwordHash || '') === String(override?.passwordHash || '')) {
      delete state.password_overrides[userId];
      startupChanged = true;
    }
  }
  if (startupChanged) writeState(stateFile, state);

  const originalComplete = runtime.api.password.completePasswordReset;
  async function completeWithAuthorityHistory(req, res) {
    const rawToken = String(req?.body?.token || '');
    const pending = state.tokens?.[sha256(rawToken)] || null;
    const userId = String(pending?.user_id || '');
    const before = userId ? runtime.api.state.userById(userId) : null;
    const previousPasswordHash = String(before?.passwordHash || '');
    await originalComplete(req, res);
    if (Number(res.statusCode || 200) >= 200 && Number(res.statusCode || 200) < 300 && userId) {
      const override = runtime.passwordOverrideForUser(userId);
      if (override) {
        override.previousPasswordHash = previousPasswordHash;
        writeState(stateFile, state);
      }
    }
    return res;
  }

  const originalFilter = runtime.api.state.filterAccountsValue;
  function filterWithNewerPasswordWins(value) {
    const users = Array.isArray(value?.users) ? value.users : [];
    let changed = false;
    for (const user of users) {
      const userId = String(user?.id || '');
      const override = runtime.passwordOverrideForUser(userId);
      if (!override) continue;
      const incomingHash = String(user?.passwordHash || '');
      const overrideHash = String(override.passwordHash || '');
      const previousHash = String(override.previousPasswordHash || '');
      const isNewerCorePassword = incomingHash && incomingHash !== overrideHash && (!previousHash || incomingHash !== previousHash);
      if (isNewerCorePassword) {
        delete state.password_overrides[userId];
        changed = true;
      }
    }
    if (changed) writeState(stateFile, state);
    return originalFilter(value);
  }

  runtime.provide({
    completePasswordReset: completeWithAuthorityHistory,
    filterAccountsValue: filterWithNewerPasswordWins,
  });
  return runtime;
}

module.exports = { installLifecyclePasswordAuthority };
