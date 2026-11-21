'use strict';
// Preflight SEGURO de la prueba integrada G3/G2 (PostgreSQL + Telegram de pruebas). SOLO LECTURA y OFFLINE:
//  - no abre conexiones de red (salvo `git ls-remote` de solo lectura), no lee .env ni archivos de credenciales, no imprime valores de variables (solo «definida»/«no definida»);
//  - no ejecuta Telegram, no revoca sesiones, no rota tokens (E7), no usa AWS.
//   node scripts/g3-preflight.cjs [--descriptor tmp/t11b/descriptor.json] [--json]
// Salida: lista de comprobaciones PASS / FAIL (riesgo: no continuar) / BLOCKED (falta autorización o material del propietario). Exit 0 solo sin FAIL.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const checks = []; const add = (id, status, detail) => checks.push({ id, status, detail });
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();
const env = process.env; const isSet = (k) => (env[k] !== undefined && env[k] !== '' ? 'definida' : 'no definida');

// 1. Repositorio
const branch = git('rev-parse', '--abbrev-ref', 'HEAD'); add('rama', branch === 'local/landing-gallery-unificada' ? 'PASS' : 'FAIL', branch);
const dirty = git('status', '--porcelain').split('\n').filter((l) => l && !/^\?\? "?(Claude outputs\/|beatgaler-console\.jpg)/.test(l));
add('arbol-limpio', dirty.length === 0 ? 'PASS' : 'FAIL', dirty.length ? `${dirty.length} cambios sin confirmar` : 'sin cambios propios');
const head = git('rev-parse', 'HEAD'); const remote = (git('ls-remote', 'origin', 'refs/heads/local/landing-gallery-unificada').split(/\s/)[0] || ''); // única lectura de red: git ls-remote (solo lectura) al remoto del repositorio
add('head-igual-remoto', head === remote ? 'PASS' : 'FAIL', `${head.slice(0, 7)} / ${remote.slice(0, 7)}`);
const tracked = git('ls-files').split('\n').filter((f) => /(^|\/)\.env(\.(?!example$)|$)|\.session$|transport-bots\.local\.json|\.env\.telegram-test/.test(f));
add('sin-credenciales-versionadas', tracked.length === 0 ? 'PASS' : 'FAIL', tracked.length ? `versionados: ${tracked.join(', ')}` : 'ningún .env/sesión/pool versionado');

// 2. Cercos de entorno (nunca se imprimen valores)
add('no-produccion', String(env.BEATGALER_DEPLOYMENT_ENV || '').toLowerCase() === 'production' ? 'FAIL' : 'PASS', `BEATGALER_DEPLOYMENT_ENV=${isSet('BEATGALER_DEPLOYMENT_ENV')}`);
add('g2-no-aprobado', String(env.BEATGALER_CATALOG_G2_APPROVED || '').toLowerCase() === 'true' ? 'FAIL' : 'PASS', 'BEATGALER_CATALOG_G2_APPROVED no debe ser «true» (STOP-GATE; solo Sol/propietario)');
add('gateway-real', String(env.BEATGALER_CATALOG_GATEWAY_ENABLED || '').toLowerCase() === 'true' ? 'PASS' : 'BLOCKED', `BEATGALER_CATALOG_GATEWAY_ENABLED=${isSet('BEATGALER_CATALOG_GATEWAY_ENABLED')} (debe activarse solo en el proceso de la prueba)`);
let dbHost = null; try { dbHost = new URL(env.DATABASE_URL).hostname; } catch { /* sin URL */ }
add('postgres-aislado', dbHost === null ? 'BLOCKED' : (['127.0.0.1', 'localhost', '::1'].includes(dbHost) ? 'PASS' : 'FAIL'), dbHost === null ? 'DATABASE_URL no definida (usar la base efímera del LAB)' : 'host loopback = ' + (['127.0.0.1', 'localhost', '::1'].includes(dbHost)));
const reservedPort = (() => { try { const p = new URL(env.DATABASE_URL).port; return ['5432', '54329'].includes(p) ? p : null; } catch { return null; } })();
add('postgres-no-reservado', reservedPort ? 'FAIL' : 'PASS', reservedPort ? `puerto reservado ${reservedPort}` : 'puerto no reservado (5432/54329 son de otros)');
for (const k of ['BEATGALER_CATALOG_NATIVE_ENABLED', 'BEATGALER_CATALOG_WORKER_ENABLED', 'BEATGALER_CATALOG_CURSOR_KEYS', 'BEATGALER_CATALOG_JOURNAL_DIR', 'BEATGALER_PROJECT_UPLOAD_TEMP_DIR']) add(`env:${k}`, env[k] ? 'PASS' : 'BLOCKED', isSet(k));

// 3. Material del sandbox (sin leer credenciales): descriptor T11-SANDBOX con forma, TTL y aprobación
const dp = argVal('--descriptor') || path.join(root, 'tmp', 't11b', 'descriptor.json');
if (!fs.existsSync(dp)) add('descriptor-t11', 'BLOCKED', 'no existe: lo emite el propietario (scope T11-SANDBOX, ≤ 24 h, production:false)');
else {
  try {
    const { loadDescriptor } = require('./catalog-transport-sandbox.cjs');
    try { loadDescriptor(dp, { env, execute: false }); add('descriptor-t11', 'PASS', 'forma, vigencia y aprobación válidas (sin --execute no se hace nada)'); }
    catch (e) {
      const msg = String(e.message || e);
      add('descriptor-t11', /falta --execute/.test(msg) ? 'PASS' : 'BLOCKED', /falta --execute/.test(msg) ? 'válido; ninguna operación ejecutada' : msg);
    }
  } catch (e) { add('descriptor-t11', 'FAIL', `no se pudo cargar el runner: ${e.message}`); }
}
add('aprobacion-propietario', env.BEATGALER_T11_SANDBOX_APPROVAL ? 'PASS' : 'BLOCKED', `BEATGALER_T11_SANDBOX_APPROVAL=${isSet('BEATGALER_T11_SANDBOX_APPROVAL')} (autorización escrita del propietario para la sesión)`);
add('e7-no-incluido', 'PASS', 'la rotación del token (E7) NO forma parte de esta prueba y no se ejecuta');
for (const f of ['docs/plans/catalogo-postgresql/G3-PRUEBA-INTEGRADA-TELEGRAM-20261117.md', 'scripts/catalog-transport-sandbox.cjs', 'scripts/backup/pg-backup.sh']) add(`archivo:${f}`, fs.existsSync(path.join(root, f)) ? 'PASS' : 'FAIL', fs.existsSync(path.join(root, f)) ? 'presente' : 'falta');

const fail = checks.filter((c) => c.status === 'FAIL'); const blocked = checks.filter((c) => c.status === 'BLOCKED');
if (args.includes('--json')) console.log(JSON.stringify({ g2: 'NOT_PROVEN', verdict: fail.length ? 'FAIL' : blocked.length ? 'LISTO_PARA_AUTORIZACION' : 'LISTO', checks }, null, 1));
else {
  for (const c of checks) console.log(`${c.status.padEnd(7)} ${c.id} — ${c.detail}`);
  console.log(`\nG2 NOT_PROVEN. Resultado: ${fail.length ? `FAIL (${fail.length})` : blocked.length ? `sin riesgos; ${blocked.length} requisitos pendientes del propietario/Sol` : 'listo'}`);
}
process.exit(fail.length ? 1 : 0);
