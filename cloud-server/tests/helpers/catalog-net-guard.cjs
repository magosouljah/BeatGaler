'use strict';
// T02 — Guard de red precargado (--require) en cada proceso de prueba del catálogo.
// Política por CATALOG_NET_POLICY:
//   deny               ningún socket TCP/TLS ni DNS (unit, faults)
//   loopback           solo 127.0.0.1 / ::1 / localhost (web: navegador + fakes locales)
//   descriptor:H:P     solo el host:puerto exacto del descriptor aprobado (integration)
// Cada intento se cuenta. Al salir, el proceso añade una línea JSON a CATALOG_NET_REPORT.
// No imprime secretos: solo api, host, puerto y si se permitió.

const net = require('net');
const tls = require('tls');
const dns = require('dns');
const fs = require('fs');

const policyRaw = String(process.env.CATALOG_NET_POLICY || 'deny');
const reportFile = process.env.CATALOG_NET_REPORT || '';
const attempts = [];
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

function parsePolicy(raw) {
  if (raw === 'deny' || raw === 'loopback') return { kind: raw };
  const m = /^descriptor:([^:]+):(\d{1,5})$/.exec(raw);
  if (m) return { kind: 'descriptor', host: m[1], port: Number(m[2]) };
  return { kind: 'deny', invalid: raw };
}
const policy = parsePolicy(policyRaw);

function allowed(host, port) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (policy.kind === 'loopback') return LOOPBACK.has(h);
  if (policy.kind === 'descriptor') return h === policy.host.toLowerCase() && Number(port) === policy.port;
  return false;
}
function blockedError(api, host, port) {
  const err = new Error(`CATALOG_NET_BLOCKED: ${api} ${host}:${port} (policy ${policy.kind})`);
  err.code = 'CATALOG_NET_BLOCKED';
  return err;
}
function record(api, host, port, ok) { attempts.push({ api, host: String(host || ''), port: port == null ? null : Number(port), allowed: ok }); }

function targetOf(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // normalizeArgs interno
  if (a && typeof a === 'object') {
    if (a.path) return { ipc: true };
    return { host: a.host || 'localhost', port: a.port };
  }
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { ipc: true };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: a };
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const t = targetOf(args);
  if (t.ipc) return origConnect.apply(this, args); // pipes/IPC locales del runner
  const ok = allowed(t.host, t.port);
  record('net.connect', t.host, t.port, ok);
  if (!ok) {
    const err = blockedError('net.connect', t.host, t.port);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};

const origTls = tls.connect;
tls.connect = function guardedTls(...args) {
  const o = args.find((x) => x && typeof x === 'object') || {};
  const host = o.host || o.servername || (typeof args[1] === 'string' ? args[1] : 'localhost');
  const port = o.port || (typeof args[0] === 'number' ? args[0] : 443);
  if (!o.socket && !allowed(host, port)) { record('tls.connect', host, port, false); throw blockedError('tls.connect', host, port); }
  return origTls.apply(this, args);
};

function guardLookup(api, orig) {
  return function guardedLookup(hostname, ...rest) {
    const ok = policy.kind !== 'deny' ? (policy.kind === 'loopback' ? LOOPBACK.has(String(hostname).toLowerCase()) : String(hostname).toLowerCase() === policy.host.toLowerCase()) : false;
    record(api, hostname, null, ok);
    if (!ok) {
      const cb = rest.find((x) => typeof x === 'function');
      const err = blockedError(api, hostname, '-');
      if (cb) { process.nextTick(() => cb(err)); return undefined; }
      throw err;
    }
    return orig.call(this, hostname, ...rest);
  };
}
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) if (typeof dns[fn] === 'function') dns[fn] = guardLookup(`dns.${fn}`, dns[fn]);
if (dns.promises) {
  for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    const orig = dns.promises[fn];
    if (typeof orig !== 'function') continue;
    dns.promises[fn] = async function guardedPromise(hostname, ...rest) {
      const ok = policy.kind === 'loopback' ? LOOPBACK.has(String(hostname).toLowerCase()) : policy.kind === 'descriptor' && String(hostname).toLowerCase() === policy.host.toLowerCase();
      record(`dns.promises.${fn}`, hostname, null, ok);
      if (!ok) throw blockedError(`dns.promises.${fn}`, hostname, '-');
      return orig.call(this, hostname, ...rest);
    };
  }
}

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    let u;
    try { u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); } catch { return origFetch(input, init); }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return origFetch(input, init);
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const ok = allowed(u.hostname, port);
    record('fetch', u.hostname, port, ok);
    if (!ok) return Promise.reject(blockedError('fetch', u.hostname, port));
    return origFetch(input, init);
  };
}

process.on('exit', () => {
  if (!reportFile) return;
  const line = JSON.stringify({ pid: process.pid, policy: policyRaw, invalid_policy: policy.invalid || null, attempts: attempts.length, blocked: attempts.filter((a) => !a.allowed).length, allowed: attempts.filter((a) => a.allowed).length, detail: attempts.slice(0, 50) });
  try { fs.appendFileSync(reportFile, line + '\n'); } catch { /* el runner marca ausencia de reporte como fallo */ }
});

module.exports = { parsePolicy, allowed, attempts };
