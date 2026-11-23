'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { login, seedAccount, sessionHashes, sha256, signIn, withAccountsPostgres } = require('./helpers/accounts-postgres.cjs');

test('M7.1f: dos procesos guardan deltas y el reinicio recupera sesiones, override y tombstone heredado', async () => {
  await withAccountsPostgres(async ({ pool, start }) => {
    const account = await seedAccount(pool, 'pg-delta', 1);
    const resetAccount = await seedAccount(pool, 'pg-reset', 2);
    const deletedAccount = await seedAccount(pool, 'pg-tombstone', 3);
    const a = await start('a');
    const b = await start('b');

    const tokenA = await signIn(a, account);
    const tokenB = await signIn(b, account);
    const { sessions } = await b.post('sessions', {}, tokenB);
    assert.equal(sessions.length, 2);
    const sessionA = sessions.find(session => !session.current);
    const sessionB = sessions.find(session => session.current);
    await b.post('sessions/revoke', { session_id: sessionA.id }, tokenB);

    // A vuelve a volcar su snapshot: todavía conoce la sesión que borró B
    // y arrancó antes de que B emitiera su propia sesión.
    const replacement = await signIn(a, account);
    assert.deepEqual(await sessionHashes(pool, account), [sha256(tokenB), sha256(replacement)].sort());
    assert.equal((await a.post('sessions', {}, tokenA, 401)).code, 'SESSION_REVOKED');

    const deletedToken = await signIn(a, deletedAccount);
    const resetToken = await signIn(a, resetAccount);
    const newPassword = 'accounts-postgres-fixture-after-reset';
    const resetRequest = await a.post('password/reset/request', { email: resetAccount.email }, undefined, 202);
    assert.equal(resetRequest.delivery_configured, true);
    const delivery = a.mail().find(message => message.kind === 'password_reset' && message.to === resetAccount.email);
    assert.match(delivery?.token, /^reset_/);
    const reset = await a.post('password/reset/complete', { token: delivery.token, newPassword });
    assert.deepEqual(reset, { ok: true, sessions_revoked: true });
    assert.deepEqual(await sessionHashes(pool, resetAccount), []);

    await a.stop();
    const lifecycleFile = path.join(a.stateDir, 'account-lifecycle-state.json');
    const readLifecycle = () => JSON.parse(fs.readFileSync(lifecycleFile, 'utf8'));
    const state = readLifecycle();
    const override = state.password_overrides[resetAccount.id];
    assert.ok(override?.passwordHash);
    const { rows: [resetRow] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [resetAccount.id]);
    assert.equal(resetRow.password_hash, override.previousPasswordHash);
    assert.notEqual(resetRow.password_hash, override.passwordHash);

    // D8 ya no crea tombstones recuperables. Reproducir el estado heredado de
    // una instalación que todavía tenía uno al arrancar con PostgreSQL.
    state.tombstones[deletedAccount.id] = { receipt_id: 'delete_fixture' };
    fs.writeFileSync(lifecycleFile, JSON.stringify(state));

    const restarted = await start('a');
    const recovered = await restarted.post('sessions', {}, tokenB);
    assert.equal(recovered.sessions.find(session => session.current)?.id, sessionB.id);
    assert.ok((await restarted.post('sessions', {}, replacement)).sessions.some(session => session.current));
    await restarted.post('sessions', {}, tokenA, 401);
    await restarted.post('sessions', {}, resetToken, 401);
    assert.deepEqual(await sessionHashes(pool, account), [sha256(tokenB), sha256(replacement)].sort());
    assert.equal((await b.post('sessions', {}, tokenB)).sessions.find(session => session.current)?.id, sessionB.id);

    assert.deepEqual(readLifecycle().tombstones, {});
    await restarted.post('sessions', {}, deletedToken, 401);
    assert.equal((await login(restarted, deletedAccount, { status: 401 })).error, 'Invalid email or password.');
    assert.equal((await login(restarted, resetAccount, { status: 401 })).error, 'Invalid email or password.');
    await signIn(restarted, resetAccount, { secret: newPassword });
  });
});
