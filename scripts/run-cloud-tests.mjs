#!/usr/bin/env node
// Runner de pruebas del Cloud (cloud-server/tests, nivel superior; el catálogo tiene su arnés scripts/catalog-check.cjs).
//
//   node scripts/run-cloud-tests.mjs                 unitarias: *.test.cjs|*.test.mjs|*.runner.cjs, sin DB ni red externa
//   node scripts/run-cloud-tests.mjs --integration   *.integration.cjs contra un PostgreSQL EFÍMERO verificado:
//       BEATGALER_CLOUD_TEST_ADMIN_URL        postgres:// en loopback (superusuario de la instancia desechable)
//       BEATGALER_CLOUD_TEST_INSTANCE_ID      id aleatorio ^bgct-[a-z0-9-]{16,}$ que quien levantó la instancia escribió en
//                                             bg_test_lab.lab_identity(instance_id) de la base de administración.
//     Sin ese centinela no se crea ni se toca nada (también con CI=true): una base real nunca lo tiene.
//   node scripts/run-cloud-tests.mjs --list [--integration]   muestra la selección sin ejecutar
//
// Seguridad: un proceso por archivo con entorno por allowlist (nunca hereda credenciales), cwd en la raíz del repo, precargas
// catalog-net-guard (solo loopback), no-dotenv (dotenv inerte) y pg-port-guard (ningún puerto PostgreSQL salvo la instancia
// verificada en --integration), AWS sin configuración, diagnósticos Direct fuera del árbol versionado. Se niega si cloud-server/
// contiene credenciales/estado locales (helpers/local-secret-files.cjs). `postgres-live.integration.cjs` nunca se ejecuta.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "cloud-server", "tests");
const helpers = path.join(testsDir, "helpers");
const PRELOADS = ["catalog-net-guard.cjs", "no-dotenv.cjs", "pg-port-guard.cjs"].map((f) => path.join(helpers, f));
const requireHere = createRequire(import.meta.url);
const { findLocalSecretFiles, REFUSAL_HELP } = requireHere(path.join(helpers, "local-secret-files.cjs"));
const args = new Set(process.argv.slice(2));
const integration = args.has("--integration");
const listOnly = args.has("--list");

// Unitarias con sujeto del lado Cloud que viven fuera de cloud-server/tests (ruta relativa a ese directorio); usan cloud-server/node_modules.
const EXTRA_UNIT = ["../../tests/e2e-web/stage1-cloud-timing.test.cjs"];
const NEVER = new Set(["postgres-live.integration.cjs"]);
// Orden implícito heredado de CI: este archivo necesita el esquema que deja el anterior en la MISMA base.
const SHARES_DB_WITH = { "direct-persistent-legacy-lazy.postgres.integration.cjs": "direct-vault-assignment.postgres.integration.cjs" };
const ADMIN_URL_VARS = ["BEATGALER_STEP1_TEST_ADMIN_URL", "BEATGALER_STEP2_TEST_ADMIN_URL", "BILLING_CHECKOUT_TEST_ADMIN_URL",
  "BILLING_LIFECYCLE_TEST_ADMIN_URL", "BILLING_E2E_TEST_ADMIN_URL", "BILLING_RECONCILIATION_TEST_ADMIN_URL",
  "BILLING_MIGRATION_TEST_ADMIN_URL", "BILLING_WEBHOOK_TEST_ADMIN_URL"];
const ENV_ALLOW = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP",
  "TMPDIR", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ",
  "CI", "GITHUB_ACTIONS"];
const INSTANCE_ID_RE = /^bgct-[a-z0-9-]{16,}$/;

function select() {
  const files = readdirSync(testsDir).filter((f) => !NEVER.has(f)).sort();
  if (integration) {
    const chosen = files.filter((f) => f.endsWith(".integration.cjs"));
    // Los que comparten base van justo después de su predecesor.
    const ordered = chosen.filter((f) => !SHARES_DB_WITH[f]);
    for (const [after, before] of Object.entries(SHARES_DB_WITH)) {
      if (!chosen.includes(after)) continue;
      const i = ordered.indexOf(before);
      if (i < 0) throw new Error(`${after} necesita ${before}, que no está en la selección`);
      ordered.splice(i + 1, 0, after);
    }
    return ordered;
  }
  return [...files.filter((f) => /\.test\.(cjs|mjs)$/.test(f) || f.endsWith(".runner.cjs")), ...EXTRA_UNIT];
}

function baseEnv(extra = {}) {
  const env = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  const scratch = path.join(os.tmpdir(), "beatgaler-cloud-tests");
  mkdirSync(path.join(scratch, "diag"), { recursive: true });
  return {
    ...env,
    NODE_ENV: "test",
    // NODE_OPTIONS trata «\» como escape dentro de comillas: rutas con «/» (válidas también en Windows).
    NODE_OPTIONS: PRELOADS.map((p) => `--require "${p.split(path.sep).join("/")}"`).join(" "),
    CATALOG_NET_POLICY: "loopback",
    DIRECT_DIAGNOSTICS_DIR: path.join(scratch, "diag"),
    AWS_CONFIG_FILE: path.join(scratch, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(scratch, "no-aws-credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
    ...extra,
  };
}

function fail(message) {
  console.error(`run-cloud-tests: ${message}`);
  process.exit(2);
}

function adminTarget() {
  const raw = process.env.BEATGALER_CLOUD_TEST_ADMIN_URL || "";
  if (!raw) fail("--integration requiere BEATGALER_CLOUD_TEST_ADMIN_URL (PostgreSQL efímero y desechable; ver la línea base en BeatGaler-arq).");
  let u;
  try { u = new URL(raw); } catch { fail("BEATGALER_CLOUD_TEST_ADMIN_URL no es una URL válida."); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) fail("BEATGALER_CLOUD_TEST_ADMIN_URL debe ser postgres://.");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) fail("solo se admite un PostgreSQL efímero en loopback.");
  const port = Number(u.port || 5432);
  // En una máquina de desarrollo el 5432 es el clúster de trabajo: nunca se usa. En CI el 5432 es el service container desechable
  // (y aun así el centinela es obligatorio).
  if (port === 5432 && process.env.CI !== "true") fail("el puerto 5432 local es el clúster de desarrollo; usa un clúster efímero propio en otro puerto.");
  const instanceId = String(process.env.BEATGALER_CLOUD_TEST_INSTANCE_ID || "");
  if (!INSTANCE_ID_RE.test(instanceId)) fail("--integration requiere BEATGALER_CLOUD_TEST_INSTANCE_ID (^bgct-[a-z0-9-]{16,}$) escrito en el centinela de la instancia efímera.");
  return { url: u, port, instanceId };
}

async function withAdmin(adminUrl, fn) {
  const requireCloud = createRequire(path.join(root, "cloud-server", "package.json"));
  const { Client } = requireCloud("pg");
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

// Antes de crear nada: la base de administración debe contener EXACTAMENTE el centinela de esta instancia efímera.
async function verifySentinel(target) {
  const rows = await withAdmin(target.url, async (c) => {
    const exists = await c.query("SELECT to_regclass('bg_test_lab.lab_identity') AS t");
    if (!exists.rows[0].t) return null;
    return (await c.query("SELECT instance_id FROM bg_test_lab.lab_identity")).rows.map((r) => r.instance_id);
  });
  if (!rows) fail("la base de administración no tiene el centinela bg_test_lab.lab_identity: no es una instancia efímera de pruebas.");
  if (rows.length !== 1 || rows[0] !== target.instanceId) fail("el centinela de la instancia no coincide con BEATGALER_CLOUD_TEST_INSTANCE_ID.");
}

function runFile(file, env, timeoutMs) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(testsDir, file)], { cwd: root, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = r.status === 0 && !r.error;
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${file} (${secs}s)${r.error ? ` — ${r.error.code || r.error.message}` : ""}`);
  if (!ok) console.log(out.trim().split(/\r?\n/).slice(-25).map((l) => `    ${l}`).join("\n"));
  return ok;
}

async function main() {
  const secrets = findLocalSecretFiles(root);
  if (secrets.length && !listOnly) fail(`este checkout contiene archivos locales con credenciales o estado real (${secrets.length}; no se leen ni se muestran).\n${REFUSAL_HELP}`);
  for (const preload of PRELOADS) if (!existsSync(preload)) fail(`falta la precarga ${path.relative(root, preload)}`);
  const files = select();
  if (listOnly) { console.log(files.join("\n")); return; }
  console.log(`run-cloud-tests: ${files.length} archivos (${integration ? "integración PostgreSQL efímero" : "unitarios"})`);
  const failed = [];
  if (!integration) {
    for (const f of files) if (!runFile(f, baseEnv(), 300_000)) failed.push(f);
  } else {
    const target = adminTarget();
    await verifySentinel(target);
    const runId = `${process.pid}_${Date.now().toString(36)}`;
    const created = [];
    const dbFor = {};
    const pgAllow = `${target.url.hostname}:${target.port}`;
    try {
      for (const [i, f] of files.entries()) {
        let db = SHARES_DB_WITH[f] ? dbFor[SHARES_DB_WITH[f]] : null;
        if (!db) {
          db = `bgct_${runId}_${i}`.toLowerCase();
          await withAdmin(target.url, (c) => c.query(`CREATE DATABASE "${db}"`));
          created.push(db);
        }
        dbFor[f] = db;
        const dbUrl = new URL(target.url); dbUrl.pathname = `/${db}`;
        const extra = { DATABASE_URL: dbUrl.toString(), BEATGALER_ALLOW_DESTRUCTIVE_PG_TEST: "true", BEATGALER_TEST_PG_ALLOW: pgAllow };
        for (const k of ADMIN_URL_VARS) extra[k] = target.url.toString();
        if (!runFile(f, baseEnv(extra), 600_000)) failed.push(f);
      }
    } finally {
      // Solo se borran las bases creadas por esta ejecución.
      await withAdmin(target.url, async (c) => { for (const db of created) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {}); }).catch(() => {});
    }
  }
  console.log(`run-cloud-tests: ${files.length - failed.length}/${files.length} PASS${failed.length ? ` · FAIL: ${failed.join(", ")}` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { console.error(`run-cloud-tests: ${error.message}`); process.exitCode = 1; });
