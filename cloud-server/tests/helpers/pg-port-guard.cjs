'use strict';
// Precarga para procesos de prueba (scripts/run-cloud-tests.mjs): ningún socket TCP a un puerto típico de PostgreSQL salvo el
// destino ya verificado por el runner (BEATGALER_TEST_PG_ALLOW="host:puerto", solo en modo --integration tras comprobar el
// centinela de la instancia efímera). Complementa al guard de red (catalog-net-guard: solo loopback): un PostgreSQL real
// alcanzable por loopback (clúster de desarrollo, túnel o port-forward) queda bloqueado igualmente.
const net = require('net');

const PG_PORTS = new Set([5432, 5433, 5434, 6432]);
const allow = String(process.env.BEATGALER_TEST_PG_ALLOW || '').trim().toLowerCase();
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

function target(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (a && typeof a === 'object') return { host: String(a.host || 'localhost'), port: Number(a.port) };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a) };
}
function allowed({ host, port }) {
  if (!allow) return false;
  const [h, p] = [allow.slice(0, allow.lastIndexOf(':')), Number(allow.slice(allow.lastIndexOf(':') + 1))];
  const norm = (x) => (LOOPBACK.has(x) ? 'loopback' : x);
  return port === p && norm(String(host).toLowerCase().replace(/^\[|\]$/g, '')) === norm(h.replace(/^\[|\]$/g, ''));
}

const orig = net.Socket.prototype.connect;
net.Socket.prototype.connect = function pgPortGuard(...args) {
  const t = target(args);
  if (Number.isFinite(t.port) && (PG_PORTS.has(t.port) || (allow && t.port === Number(allow.split(':').pop()))) && !allowed(t)) {
    const err = Object.assign(new Error(`TEST_PG_BLOCKED: ${t.host}:${t.port} no es la instancia efímera verificada`), { code: 'TEST_PG_BLOCKED' });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return orig.apply(this, args);
};
