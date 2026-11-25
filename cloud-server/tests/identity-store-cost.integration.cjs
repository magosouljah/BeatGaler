'use strict';

// M7.4-char: medición (no aserción de rendimiento) del coste por petición autenticada con N cuentas en PostgreSQL.
// Solo corre con BEATGALER_M74_MEASURE_N=<N> (un tamaño por ejecución: cada ejecución usa su propia base); sin ella no hace nada, para no gastar tiempo en CI.
// Imprime TSV: N, arranque (ms), media/p95 de /auth/lifecycle/status y /auth/sessions, media de login (ruta de escritura).
const assert = require('node:assert/strict');
const test = require('node:test');
const { seedAccount, signIn, withAccountsPostgres } = require('./helpers/accounts-postgres.cjs');

const sizes = String(process.env.BEATGALER_M74_MEASURE_N || '').split(',').map(Number).filter(Number.isFinite);
const p95 = values => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

test('M7.4-char: coste por petición autenticada con N cuentas (medición)', { skip: !sizes.length }, async () => {
  const rows = [];
  for (const n of sizes) {
    await withAccountsPostgres(async ({ pool, start }) => {
      const account = await seedAccount(pool, `m74-cost-${n}`, 5);
      await pool.query(`INSERT INTO users(id,username,username_source,email,password_hash,password_hash_algorithm,password_salt)
        SELECT 'usr_fill_'||i,'fill'||i||'#0001','beatgaler','fill'||i||'@example.test',repeat('b',128),'scrypt',repeat('a',32)
        FROM generate_series(1,$1::int) i`, [Math.max(0, n - 1)]);
      await pool.query(`INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at)
        SELECT md5(i::text)||md5((i+1)::text),'usr_fill_'||i,now()-interval '1 hour',now()+interval '1 day' FROM generate_series(1,$1::int) i`, [Math.max(0, n - 1)]);
      const t0 = Date.now();
      const cloud = await start('cost');
      const bootMs = Date.now() - t0;
      const token = await signIn(cloud, account);
      const time = async route => {
        const samples = [];
        for (let i = 0; i < 30; i += 1) { const t = process.hrtime.bigint(); await cloud.post(route, {}, token); samples.push(Number(process.hrtime.bigint() - t) / 1e6); }
        return samples.slice(3);
      };
      const status = await time('lifecycle/status');
      const sessions = await time('sessions');
      const logins = [];
      for (let i = 0; i < 5; i += 1) { const t = process.hrtime.bigint(); await signIn(cloud, account); logins.push(Number(process.hrtime.bigint() - t) / 1e6); }
      rows.push([n, bootMs, `${mean(status).toFixed(1)}/${p95(status).toFixed(1)}`, `${mean(sessions).toFixed(1)}/${p95(sessions).toFixed(1)}`, mean(logins).toFixed(0)].join('\t'));
    });
  }
  console.log('N\tarranque_ms\tlifecycle/status ms (media/p95)\tsessions ms (media/p95)\tlogin ms (media)');
  console.log(rows.join('\n'));
  assert.equal(rows.length, sizes.length);
});
