'use strict';

// M7.4-char: comportamiento del almacén de identidad con PostgreSQL y dos procesos Cloud (se ejecuta con el PG efímero).
// Fija lo que M7.4 no puede cambiar sin decisión: qué ve cada proceso, quién decide la validez y que la respuesta
// no sale antes de confirmar la escritura. Complementa M7.1e/f (accounts-*-postgres.integration.cjs), sin repetirlas.
const assert = require('node:assert/strict');
const test = require('node:test');
const { emailHash } = require('../email-verification-authority');
const { login, password, seedAccount, sessionHashes, sha256, signIn, withAccountsPostgres } = require('./helpers/accounts-postgres.cjs');

test('M7.4-char: sesión vencida en PostgreSQL: PostgreSQL decide aunque el proceso la crea vigente', async () => {
  await withAccountsPostgres(async ({ pool, start }) => {
    const account = await seedAccount(pool, 'm74-expiry', 1);
    const a = await start('a');
    const token = await signIn(a, account);
    await a.post('sessions', {}, token);
    await pool.query("UPDATE auth_sessions SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE session_key_hash=$1", [sha256(token)]);
    const rejected = await a.post('sessions', {}, token, 401);
    assert.equal(rejected.code, 'SESSION_REVOKED');
    // Tras el reinicio la sesión vencida ya no entra en el almacén del proceso.
    await a.stop();
    const restarted = await start('a');
    assert.equal((await restarted.post('sessions', {}, token, 401)).code, 'SESSION_EXPIRED');
  });
});

test('M7.4-char: el almacén es local a cada proceso: sesión y usuario ajenos solo se ven tras reiniciar', async () => {
  await withAccountsPostgres(async ({ pool, start }) => {
    const known = await seedAccount(pool, 'm74-known', 2);
    const a = await start('a');
    const b = await start('b');
    // Sesión emitida por A y presentada a B: PostgreSQL la tiene, el almacén de B no.
    const tokenA = await signIn(a, known);
    assert.deepEqual(await sessionHashes(pool, known), [sha256(tokenA)]);
    assert.equal((await b.post('sessions', {}, tokenA, 401)).code, 'SESSION_EXPIRED');
    assert.ok((await a.post('sessions', {}, tokenA)).sessions.some(session => session.current));

    // Usuario creado en PostgreSQL con los procesos ya en marcha: ninguno lo conoce hasta reiniciar.
    const late = await seedAccount(pool, 'm74-late', 3);
    assert.equal((await login(a, late, { status: 401 })).error, 'Invalid email or password.');
    assert.equal((await login(b, late, { status: 401 })).error, 'Invalid email or password.');
    const fresh = await start('c');
    assert.match(await signIn(fresh, late), /^[A-Za-z0-9_-]{43}$/);
    // Un proceso nuevo sí recibe las sesiones vigentes de PostgreSQL.
    assert.ok((await fresh.post('sessions', {}, tokenA)).sessions.some(session => session.current));
  });
});

test('M7.4-char: la respuesta de password/change sale con la contraseña ya confirmada en PostgreSQL', async () => {
  await withAccountsPostgres(async ({ pool, start }) => {
    const account = await seedAccount(pool, 'm74-durable', 4);
    const cloud = await start('a');
    // Con el correo verificado, el cambio de contraseña pide una reautenticación reciente.
    await pool.query('INSERT INTO user_email_verifications(user_id,email_hash,verified_at) VALUES($1,$2,now())', [account.id, emailHash(account.email)]);
    const token = await signIn(cloud, account);
    const { reauth_token: proof } = await cloud.post('reauth', { password }, token);
    const before = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [account.id])).rows[0].password_hash;
    const newPassword = 'm74-durable-new-password';
    const changed = await cloud.post('password/change', { currentPassword: password, newPassword, reauthToken: proof }, token);
    assert.equal(changed.ok, true);
    // Lectura desde otra conexión inmediatamente después de la respuesta: sin esperas ni reintentos.
    const after = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [account.id])).rows[0].password_hash;
    assert.notEqual(after, before);
    await signIn(cloud, account, { secret: newPassword });
    await login(cloud, account, { status: 401 });
  });
});
