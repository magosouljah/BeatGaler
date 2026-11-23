'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

const authFile = 'accounts-data.json';
const sessionFile = 'session-security-state.json';
const lifecycleFile = 'account-lifecycle-state.json';
const newPassword = 'composition-fake-after-reset';
const deleted = { id: 'usr_deleted_fixture', email: 'deleted@example.test', username: 'deleted' };
const hash = value => createHash('sha256').update(value).digest('hex');
const readState = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const writeState = (dir, file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
const post = (send, route, body = {}, token) => send('POST', '/auth/' + route, {
  body, headers: token ? { authorization: 'Bearer ' + token } : {},
});
const login = (send, password, email = account.email, beatgalerUserId = account.beatgalerUserId) => post(send, 'login', {
  email, password, beatgalerUserId,
});

function json(response, status) {
  assert.equal(response.status, status, response.data);
  return JSON.parse(response.data);
}

async function verifyReboot(fixture) {
  let stateDir;
  await withCloud(async (_app, send) => {
    // El arranque consume el tombstone y elimina la fila de cuentas obsoleta.
    assert.deepEqual(readState(stateDir, lifecycleFile).tombstones, {});
    assert.equal(readState(stateDir, authFile).users.some(user => user.id === deleted.id), false,
      'El arranque debe eliminar la fila obsoleta marcada por el tombstone');
    assert.deepEqual(json(await login(send, account.password, deleted.email, 'deleted-fixture-installation'), 401), {
      error: 'Invalid email or password.',
    });

    const active = json(await post(send, 'sessions', {}, fixture.activeToken), 200);
    assert.equal(active.sessions.find(session => session.current)?.id, fixture.activeSessionId);
    const revoked = json(await post(send, 'sessions', {}, fixture.revokedToken), 401);
    assert.equal(revoked.code, 'SESSION_REVOKED');

    // El snapshot de cuentas tiene todavía el hash anterior al reset.
    assert.equal(json(await login(send, account.password), 401).error, 'Invalid email or password.');
    assert.equal(json(await login(send, newPassword), 200).user.id, account.id);
  }, {
    requestTimeoutMs: 10_000,
    prepare: dir => { stateDir = dir; },
    restoreState(dir) {
      for (const [file, value] of Object.entries(fixture.state)) writeState(dir, file, value);
    },
  });
}

if (process.argv[2] === '--verify-reboot') {
  verifyReboot(readState(path.dirname(process.argv[3]), path.basename(process.argv[3]))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  test('Otro proceso recupera sesiones, revocaciones, password overrides y tombstones del JSON', async () => {
    const childEnv = Object.fromEntries(
      ['Path', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'NODE_OPTIONS', 'DIRECT_DIAGNOSTICS_DIR', 'CATALOG_NET_POLICY']
        .filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]]),
    );
    let stateDir;
    await withCloud(async (app, send) => {
      const originalUser = readState(stateDir, authFile).users[0];
      const lifecycle = app.__beatgalerAccountLifecycleRuntime._test;
      const token = lifecycle.issueTestToken({ kind: 'password_reset', user: originalUser });
      // El arnés no tiene proveedor de correo. Se emite el token local y se
      // ejecuta el handler de reset antes de crear sesiones que revocar.
      const response = { json(value) { this.value = value; return this; } };
      await lifecycle.completePasswordReset({ body: { token, newPassword } }, response);
      assert.deepEqual(response.value, { ok: true, sessions_revoked: true });

      const activeToken = json(await login(send, newPassword), 200).token;
      const revokedToken = json(await login(send, newPassword), 200).token;
      const { sessions } = json(await post(send, 'sessions', {}, activeToken), 200);
      const activeSessionId = sessions.find(session => session.current).id;
      const staleSession = readState(stateDir, authFile).sessions[hash(revokedToken)];
      assert.equal(staleSession.userId, account.id);
      assert.deepEqual(json(await post(send, 'logout', {}, revokedToken), 200), { ok: true });

      const accounts = readState(stateDir, authFile);
      const sessionState = readState(stateDir, sessionFile);
      const lifecycleState = readState(stateDir, lifecycleFile);
      assert.equal(accounts.sessions[hash(revokedToken)], undefined);
      assert.ok(sessionState.revoked_session_hashes.includes(hash(revokedToken)));
      assert.notEqual(lifecycleState.password_overrides[account.id].passwordHash, originalUser.passwordHash);

      accounts.users[0] = originalUser;
      accounts.users.push({ ...originalUser, ...deleted });
      accounts.sessions[hash(revokedToken)] = staleSession;
      lifecycleState.tombstones[deleted.id] = { receipt_id: 'delete_fixture' };
      const fixtureFile = 'restart-fixture.json';
      writeState(stateDir, fixtureFile, {
        activeToken, revokedToken, activeSessionId,
        state: { [authFile]: accounts, [sessionFile]: sessionState, [lifecycleFile]: lifecycleState },
      });
      try {
        execFileSync(process.execPath, [
          ...process.execArgv, __filename, '--verify-reboot', path.join(stateDir, fixtureFile),
        ], { env: childEnv, timeout: 70_000, stdio: 'pipe' });
      } catch (error) {
        assert.fail(`Reinicio fallido (${error.status ?? error.code}):\n${error.stderr}\n${error.stdout}`);
      }
    }, { prepare: dir => { stateDir = dir; }, requestTimeoutMs: 10_000 });
  });
}
