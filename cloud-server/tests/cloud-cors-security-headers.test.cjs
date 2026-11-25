'use strict';

// Sustituye las aserciones de texto de regression-task-5.1-hardening.mjs sobre
// server-core.js (lista blanca CORS), server.js y security-headers.js por lo que
// responde el Cloud arrancado.
const assert = require('node:assert/strict');
const { withCloud } = require('./helpers/composition-cloud.cjs');

const allowed = 'https://app.example.test';
const stranger = 'https://stranger.example.test';

withCloud(async (_app, send) => {
  const preflight = origin => send('OPTIONS', '/auth/logout', {
    headers: { origin, 'access-control-request-method': 'POST' },
  });

  const listed = await preflight(allowed);
  assert.equal(listed.status, 204);
  assert.equal(listed.headers['access-control-allow-origin'], allowed, 'BEATGALER_ALLOWED_ORIGINS must be honoured');
  assert.equal(listed.headers.vary, 'Origin');
  assert.equal(listed.headers['access-control-allow-methods'], 'GET, POST, PATCH, PUT, OPTIONS');

  const unlisted = await preflight(stranger);
  assert.equal(unlisted.status, 204);
  assert.equal(unlisted.headers['access-control-allow-origin'], undefined, 'unlisted origins get no CORS grant');
  assert.equal(unlisted.headers['access-control-allow-credentials'], undefined);

  const health = await send('GET', '/auth/health', { headers: { origin: stranger } });
  assert.equal(health.status, 200);
  assert.equal(health.headers['access-control-allow-origin'], undefined);
  assert.equal(health.headers['access-control-allow-credentials'], undefined);
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.equal(health.headers['referrer-policy'], 'no-referrer');
  assert.equal(health.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(health.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers.pragma, 'no-cache');

  const catalog = await send('GET', '/catalog/v1/context', { headers: {} });
  assert.equal(catalog.headers['x-content-type-options'], 'nosniff', 'security headers cover every API route');
  console.log('cloud-cors-security-headers tests: PASS');
}, { prepare() { process.env.BEATGALER_ALLOWED_ORIGINS = allowed; } }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
