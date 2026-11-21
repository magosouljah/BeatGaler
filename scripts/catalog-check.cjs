#!/usr/bin/env node
'use strict';
// T02 — Runner de verificación del catálogo PostgreSQL.
// Uso: node scripts/catalog-check.cjs <suite> [--out <dir>] [--manifest <file>]
// Suites: unit | integration | faults | web | all-local | perf | T03..T21 (ver scripts/catalog-suites.json).
// Exit: 0 PASS · 1 algún caso falló/skip/vacío/red · 2 uso o suite inexistente · 3 prerequisito ausente
//       4 suite registrada sin casos (pending) · 5 manifiesto o caso no permitido.
// El hijo NO hereda el entorno: se construye por allowlist. Nunca imprime valores de variables.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const GUARD = path.join(REPO, 'cloud-server', 'tests', 'helpers', 'catalog-net-guard.cjs');
const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, PREREQ: 3, PENDING: 4, MANIFEST: 5 };

// Variables de sistema que necesita un proceso Node/Chrome; ninguna es credencial.
const ENV_ALLOW = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ', 'CI', 'GITHUB_ACTIONS', 'CHROME_BIN'];
// Solo para suites que declaran requires: ["catalog-test-db"].
const ENV_DB = ['CATALOG_TEST_ADMIN_URL', 'CATALOG_TEST_INSTANCE_ID'];
const SENSITIVE = /DATABASE_URL|^PG|AWS|TELEGRAM|POLAR|SMTP|SES_|SECRET|TOKEN|PASSWORD|PASSWD|_KEY|APIKEY|BEATGALER|MASTER|BOT_|COOKIE|SESSION/i;
const HARD_FORBIDDEN = [/postgres-live\.integration\.cjs$/i, /(^|[\\/])\.env(\.|$)/i, /^--env-file/i, /^-r$|^--require$/];

function usage(msg) {
  if (msg) process.stderr.write(`catalog-check: ${msg}\n`);
  process.stderr.write('uso: node scripts/catalog-check.cjs <suite> [--out <dir>] [--manifest <file>]\n');
}

function parseArgs(argv) {
  const out = { suite: null, outDir: null, manifest: path.join(REPO, 'scripts', 'catalog-suites.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a.startsWith('-')) throw Object.assign(new Error(`opción desconocida ${a}`), { exit: EXIT.USAGE });
    else if (!out.suite) out.suite = a;
    else throw Object.assign(new Error(`argumento extra ${a}`), { exit: EXIT.USAGE });
  }
  if (!out.suite) throw Object.assign(new Error('falta la suite'), { exit: EXIT.USAGE });
  return out;
}

function loadManifest(file) {
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw Object.assign(new Error(`manifiesto ilegible: ${e.message}`), { exit: EXIT.MANIFEST }); }
  if (m.schema !== 'beatgaler.catalog-suites' || !m.suites || typeof m.suites !== 'object') throw Object.assign(new Error('manifiesto inválido'), { exit: EXIT.MANIFEST });
  return m;
}

function resolveSuites(manifest, name, seen = new Set()) {
  const s = manifest.suites[name];
  if (!s) throw Object.assign(new Error(`suite inexistente: ${name}`), { exit: EXIT.USAGE });
  if (seen.has(name)) throw Object.assign(new Error(`ciclo en aggregate: ${name}`), { exit: EXIT.MANIFEST });
  seen.add(name);
  if (s.status === 'aggregate') return (s.includes || []).flatMap((n) => resolveSuites(manifest, n, seen));
  if (s.status === 'pending' || !Array.isArray(s.cases) || s.cases.length === 0) {
    throw Object.assign(new Error(`suite ${name} registrada sin casos (propietaria ${s.owner || '?'}): no se ejecuta ni se da por pasada`), { exit: EXIT.PENDING });
  }
  if (s.status !== 'active') throw Object.assign(new Error(`estado de suite no soportado: ${s.status}`), { exit: EXIT.MANIFEST });
  return [{ name, ...s }];
}

function validateCase(manifest, suite, c) {
  const roots = (manifest.allowed_case_roots || []).map((r) => path.resolve(REPO, r));
  const forbidden = (manifest.forbidden_case_files || []).map((f) => path.resolve(REPO, f));
  if (!c || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id)) throw Object.assign(new Error(`caso con id inválido en ${suite.name}`), { exit: EXIT.MANIFEST });
  if (!Array.isArray(c.cmd) || c.cmd[0] !== 'node' || c.cmd.length < 2) throw Object.assign(new Error(`caso ${c.id}: solo se permiten comandos node`), { exit: EXIT.MANIFEST });
  for (const arg of c.cmd.slice(1)) if (HARD_FORBIDDEN.some((re) => re.test(arg))) throw Object.assign(new Error(`caso ${c.id}: argumento prohibido`), { exit: EXIT.MANIFEST });
  const files = c.cmd.slice(1).filter((a) => !a.startsWith('-'));
  if (!files.length) throw Object.assign(new Error(`caso ${c.id}: sin archivo`), { exit: EXIT.MANIFEST });
  for (const f of files) {
    const abs = path.resolve(REPO, f);
    if (forbidden.includes(abs)) throw Object.assign(new Error(`caso ${c.id}: archivo prohibido ${f}`), { exit: EXIT.MANIFEST });
    if (!roots.some((r) => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) throw Object.assign(new Error(`caso ${c.id}: ${f} fuera de allowed_case_roots`), { exit: EXIT.MANIFEST });
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`caso ${c.id}: no existe ${f}`), { exit: EXIT.MANIFEST });
  }
  if (!['node-test', 'plain'].includes(c.kind)) throw Object.assign(new Error(`caso ${c.id}: kind inválido`), { exit: EXIT.MANIFEST });
}

function checkPrereqs(suite, env) {
  const notes = {};
  for (const req of suite.requires || []) {
    if (req === 'catalog-test-db') {
      const db = require(path.join(REPO, 'cloud-server', 'tests', 'helpers', 'catalog-test-db.cjs'));
      try {
        const v = db.validateAdminTarget({ env });
        notes.netPolicy = `descriptor:${v.host}:${v.port}`;
      } catch (e) {
        throw Object.assign(new Error(`prerequisito catalog-test-db ausente o no permitido: ${e.code || e.message}`), { exit: EXIT.PREREQ });
      }
    } else if (req === 'chrome') {
      const chrome = env.CHROME_BIN || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
      if (!fs.existsSync(chrome)) throw Object.assign(new Error('prerequisito chrome ausente'), { exit: EXIT.PREREQ });
      if (!fs.existsSync(path.join(REPO, 'node_modules', '@wdio', 'cli'))) throw Object.assign(new Error('prerequisito @wdio/cli ausente'), { exit: EXIT.PREREQ });
    } else {
      throw Object.assign(new Error(`prerequisito desconocido ${req}`), { exit: EXIT.MANIFEST });
    }
  }
  return notes;
}

function buildChildEnv(parentEnv, suite, extra) {
  const env = {};
  for (const k of ENV_ALLOW) if (parentEnv[k] !== undefined) env[k] = parentEnv[k];
  if ((suite.requires || []).includes('catalog-test-db')) for (const k of ENV_DB) if (parentEnv[k] !== undefined) env[k] = parentEnv[k];
  Object.assign(env, extra);
  return env;
}

function droppedNames(parentEnv, childEnv) {
  const dropped = Object.keys(parentEnv).filter((k) => !(k in childEnv));
  return { count: dropped.length, sensitive: dropped.filter((k) => SENSITIVE.test(k)).sort() };
}

function parseTap(text) {
  const n = (k) => { const m = new RegExp(`^# ${k} (\\d+)`, 'm').exec(text); return m ? Number(m[1]) : null; };
  // node --test cuenta un archivo sin test() como un test aprobado con el nombre del archivo.
  const fileOnly = /^# Subtest: .*\.(c|m)?js$/m.test(text);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), todo: n('todo'), cancelled: n('cancelled'), file_without_tests: fileOnly };
}

function readNet(file) {
  if (!fs.existsSync(file)) return { processes: 0, attempts: 0, blocked: 0, allowed: 0, detail: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return {
    processes: lines.length,
    attempts: lines.reduce((a, l) => a + l.attempts, 0),
    blocked: lines.reduce((a, l) => a + l.blocked, 0),
    allowed: lines.reduce((a, l) => a + l.allowed, 0),
    invalid_policy: lines.some((l) => l.invalid_policy),
    detail: lines.flatMap((l) => l.detail).slice(0, 20),
  };
}

function runCase(c, suite, ctx) {
  return new Promise((resolve) => {
    const caseDir = path.join(ctx.outDir, 'cases', `${suite.name}--${c.id}`);
    fs.mkdirSync(caseDir, { recursive: true });
    const netFile = path.join(caseDir, 'net.jsonl');
    const logFile = path.join(ctx.outDir, 'logs', `${suite.name}--${c.id}.log`);
    const policy = c.network || (suite.network === 'descriptor' ? ctx.prereq.netPolicy : suite.network) || 'deny';
    const env = buildChildEnv(process.env, suite, {
      CATALOG_NET_POLICY: policy, CATALOG_NET_REPORT: netFile, CATALOG_CHECK_RUN_ID: ctx.runId, CATALOG_CHECK_CASE_DIR: caseDir,
      NODE_OPTIONS: `--require=${GUARD}`,
    });
    const args = c.cmd.slice(1);
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const log = fs.createWriteStream(logFile);
    const onData = (d) => { out += d.toString(); log.write(d); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timeoutMs = Number(c.timeout_ms || 180000);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer); log.end();
      const net = readNet(netFile);
      const r = { suite: suite.name, id: c.id, cmd: c.cmd.join(' '), kind: c.kind, network_policy: policy, exit: code, signal, duration_ms: Date.now() - started, log: path.relative(ctx.outDir, logFile), net: { processes: net.processes, attempts: net.attempts, blocked: net.blocked, allowed: net.allowed }, reasons: [] };
      if (timedOut) r.reasons.push('TIMEOUT');
      if (code !== 0) r.reasons.push(`EXIT_${code}`);
      if (c.kind === 'node-test') {
        const t = parseTap(out); r.tap = t;
        if (t.tests == null) r.reasons.push('TAP_SUMMARY_MISSING');
        else {
          if (t.tests === 0 || t.file_without_tests) r.reasons.push('EMPTY');
          if (t.fail) r.reasons.push('TEST_FAIL');
          if (t.skipped || t.todo) r.reasons.push('SKIPPED');
          if (t.cancelled) r.reasons.push('CANCELLED');
        }
        r.executed = t.tests || 0; r.failed = (t.fail || 0) + (t.cancelled || 0); r.skipped = (t.skipped || 0) + (t.todo || 0);
      } else { r.executed = 1; r.failed = code === 0 ? 0 : 1; r.skipped = 0; }
      if (net.processes === 0) r.reasons.push('NET_GUARD_MISSING');
      if (net.invalid_policy) r.reasons.push('NET_POLICY_INVALID');
      if (policy === 'deny' && net.attempts > 0) r.reasons.push('NETWORK_ATTEMPT_IN_DENY');
      if (net.blocked > 0) r.reasons.push('NETWORK_BLOCKED');
      if (r.reasons.length) r.net.detail = net.detail;
      r.result = r.reasons.length ? 'FAIL' : 'PASS';
      resolve(r);
    });
  });
}

function gitHead() { try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: buildChildEnv(process.env, {}, {}) }).trim(); } catch { return null; } }

function writeSummary(ctx, summary) {
  fs.writeFileSync(path.join(ctx.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const lines = [`catalog-check ${summary.suite} run=${summary.run_id} result=${summary.result} exit=${summary.exit}`,
    `head=${summary.head} node=${summary.node}`,
    `ejecutados=${summary.totals.executed} fallados=${summary.totals.failed} skipped=${summary.totals.skipped} casos=${summary.cases.length}`,
    `entorno: ${summary.env.dropped_count} variables no heredadas; sensibles descartadas: ${summary.env.sensitive_dropped.join(', ') || 'ninguna'}`];
  if (summary.error) lines.push(`error: ${summary.error}`);
  for (const c of summary.cases) lines.push(`  ${c.result} ${c.suite}/${c.id} exit=${c.exit} tests=${c.executed} fail=${c.failed} skip=${c.skipped} net=${c.net.attempts}/${c.net.blocked} ${c.reasons.join(',')}`);
  fs.writeFileSync(path.join(ctx.outDir, 'summary.txt'), lines.join('\n') + '\n');
  return lines.join('\n');
}

async function main(argv) {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(4).toString('hex')}`;
  let args;
  try { args = parseArgs(argv); } catch (e) { usage(e.message); return e.exit || EXIT.USAGE; }
  const outDir = path.resolve(args.outDir || path.join(REPO, 'tmp', 'catalog-check', `${args.suite}-${runId}`));
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true });
  const ctx = { runId, outDir, prereq: {} };
  const childProbe = buildChildEnv(process.env, { requires: [] }, {});
  const d = droppedNames(process.env, childProbe);
  const summary = { schema: 'beatgaler.catalog-check-summary', version: 1, run_id: runId, suite: args.suite, started_at: new Date().toISOString(), head: gitHead(), node: process.version, platform: process.platform, manifest: path.relative(REPO, args.manifest), env: { dropped_count: d.count, sensitive_dropped: d.sensitive }, cases: [], totals: { executed: 0, failed: 0, skipped: 0 } };
  let exit = EXIT.PASS;
  try {
    const manifest = loadManifest(args.manifest);
    const suites = resolveSuites(manifest, args.suite);
    for (const s of suites) for (const c of s.cases) validateCase(manifest, s, c);
    for (const s of suites) {
      ctx.prereq = checkPrereqs(s, buildChildEnv(process.env, s, {})); // mismo entorno filtrado que verá el hijo
      for (const c of s.cases) {
        const r = await runCase(c, s, ctx);
        summary.cases.push(r);
        summary.totals.executed += r.executed; summary.totals.failed += r.failed; summary.totals.skipped += r.skipped;
        if (r.result !== 'PASS') exit = EXIT.FAIL;
      }
    }
    if (summary.totals.executed === 0) { exit = EXIT.FAIL; summary.error = 'NO_TESTS_EXECUTED'; }
  } catch (e) {
    exit = e.exit || EXIT.FAIL; summary.error = e.message;
  }
  summary.finished_at = new Date().toISOString();
  summary.exit = exit; summary.result = exit === 0 ? 'PASS' : 'FAIL';
  summary.out_dir = outDir;
  process.stdout.write(writeSummary(ctx, summary) + `\nsalida: ${outDir}\n`);
  return exit;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main, parseArgs, loadManifest, resolveSuites, validateCase, buildChildEnv, droppedNames, parseTap, readNet, EXIT, ENV_ALLOW, ENV_DB };
