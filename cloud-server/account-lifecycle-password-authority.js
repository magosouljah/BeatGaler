'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.authority-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function installLifecyclePasswordAuthority(runtime) {
  if (!runtime?._test || runtime.__beatgalerPasswordAuthoritySyncInstalled) return runtime;
  runtime.__beatgalerPasswordAuthoritySyncInstalled = true;
  const state = runtime._test.stateSnapshot();
  const stateFile = runtime._test.stateFile;

  // After a restart the durable accounts snapshot already carries the reset
  // password authority. The compatibility override is no longer needed.
  let startupChanged = false;
  const startup = runtime._test.accountsSnapshot();
  for (const [userId, override] of Object.entries(state.password_overrides || {})) {
    const user = startup.users.find(row => String(row?.id || '') === String(userId));
    if (user && String(user.passwordHash || '') === String(override?.passwordHash || '')) {
      delete state.password_overrides[userId];
      startupChanged = true;
    }
  }
  if (startupChanged) writeState(stateFile, state);

  const originalComplete = runtime._test.completePasswordReset;
  runtime._test.completePasswordReset = async function completeWithAuthorityHistory(req, res) {
    const rawToken = String(req?.body?.token || '');
    const pending = state.tokens?.[sha256(rawToken)] || null;
    const userId = String(pending?.user_id || '');
    const before = userId ? runtime._test.userById(userId) : null;
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
  };

  const originalFilter = runtime._test.filterAccountsValue;
  runtime._test.filterAccountsValue = function filterWithNewerPasswordWins(value) {
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
  };

  return runtime;
}

module.exports = { installLifecyclePasswordAuthority };
