'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { login, password, seedAccount, sessionHashes, sha256, signIn, withAccountsPostgres } = require('./helpers/accounts-postgres.cjs');

test('M7.1e: login, sesión y lifecycle con revocación PostgreSQL desde otro proceso', async () => {
  await withAccountsPostgres(async ({ pool, start }) => {
    const account = await seedAccount(pool, 'pg-sessions', 1);
    const a = await start('a');
    const b = await start('b');
    const tokenA = await signIn(a, account);
    const tokenB = await signIn(b, account);
    assert.deepEqual(await sessionHashes(pool, account), [sha256(tokenA), sha256(tokenB)].sort());

    const resumed = await a.post('session', { beatgalerUserId: account.installation }, tokenA);
    assert.equal(resumed.user.id, account.id);
    const lifecycle = await a.post('lifecycle/status', {}, tokenA);
    assert.equal(lifecycle.ok, true);
    assert.equal(lifecycle.email_verified, false);

    const listA = await a.post('sessions', {}, tokenA);
    assert.equal(listA.ok, true);
    assert.equal(listA.sessions.length, 2);
    const currentA = listA.sessions.filter(session => session.current);
    assert.equal(currentA.length, 1);
    const [sessionA] = currentA;
    const listB = await b.post('sessions', {}, tokenB);
    assert.deepEqual(new Set(listB.sessions.map(session => session.id)), new Set(listA.sessions.map(session => session.id)));
    assert.equal(listB.sessions.find(session => session.id === sessionA.id)?.current, false);

    const revoked = await b.post('sessions/revoke', { session_id: sessionA.id }, tokenB);
    assert.deepEqual(revoked, { ok: true, revoked_session_id: sessionA.id, current_revoked: false });
    assert.equal((await a.post('sessions', {}, tokenA, 401)).code, 'SESSION_REVOKED');
    assert.deepEqual(await sessionHashes(pool, account), [sha256(tokenB)]);

    const anotherTokenB = await signIn(b, account);
    const all = await b.post('sessions/revoke-all', {}, tokenB);
    assert.deepEqual(all, { ok: true, revoked_count: 2, current_revoked: true });
    for (const token of [tokenB, anotherTokenB]) {
      assert.equal((await b.post('sessions', {}, token, 401)).code, 'SESSION_REVOKED');
    }
    assert.deepEqual(await sessionHashes(pool, account), []);
  });
});

test('M7.1e: cambio escalonado de email con reenvío, rotación del código y revocación', async () => {
  // La base es por archivo. Este caso vuelve a usar el marcador de cutover del anterior.
  await withAccountsPostgres(async ({ pool, start }) => {
    const account = await seedAccount(pool, 'pg-email', 2);
    const cloud = await start('email');
    const token = await signIn(cloud, account);
    const email = 'pg-email-updated@example.test';
    const { reauth_token: proof } = await cloud.post('reauth', { password }, token);
    assert.match(proof, /^reauth_/);

    const pending = await cloud.post('email/change/start', { email, reauthToken: proof }, token, 202);
    assert.equal(pending.pending, true);
    assert.match(pending.request_id, /^emc_/);
    const [first] = cloud.mail();
    assert.equal(first.kind, 'email_change_confirmation');
    assert.equal(first.to, email);
    assert.match(first.token, /^emc_/);
    assert.equal((await pool.query('SELECT email FROM users WHERE id=$1', [account.id])).rows[0].email, account.email);

    assert.equal((await cloud.post('email/change/resend', {}, token, 429)).code, 'EMAIL_CHANGE_RESEND_COOLDOWN');
    assert.equal(cloud.mail().length, 1);
    // Envejecer exclusivamente la entrega de la fixture evita dormir durante el cooldown.
    await pool.query("UPDATE auth_email_changes SET last_delivery_at=now()-interval '5 minutes' WHERE user_id=$1", [account.id]);
    const resent = await cloud.post('email/change/resend', {}, token, 202);
    assert.equal(resent.pending, true);
    assert.notEqual(resent.request_id, pending.request_id);
    const [, second] = cloud.mail();
    assert.equal(second.kind, 'email_change_confirmation');
    assert.equal(second.to, email);
    assert.match(second.token, /^emc_/);
    assert.notEqual(second.token, first.token);
    const invalid = await cloud.post('email/change/confirm', { token: first.token }, token, 400);
    assert.equal(invalid.code, 'EMAIL_CHANGE_INVALID');

    const confirmed = await cloud.post('email/change/confirm', { token: second.token }, token);
    assert.deepEqual(confirmed, { ok: true, email, sessions_revoked: true, old_email_notified: true });
    assert.deepEqual(cloud.mail().filter(message => message.kind === 'email_changed_notice'),
      [{ kind: 'email_changed_notice', to: account.email }]);
    assert.deepEqual(await sessionHashes(pool, account), []);
    await cloud.post('sessions', {}, token, 401);
    await login(cloud, account, { status: 401 });
    const newSession = await signIn(cloud, account, { email });
    assert.equal((await cloud.post('lifecycle/status', {}, newSession)).email_verified, true);
  });
});
