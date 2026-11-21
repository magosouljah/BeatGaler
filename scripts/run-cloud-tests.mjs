#!/usr/bin/env node
// Runner de pruebas del Cloud (cloud-server/tests, nivel superior; el catálogo tiene su arnés scripts/catalog-check.cjs).
//
//   node scripts/run-cloud-tests.mjs                 unitarias: *.test.cjs|*.test.mjs|*.runner.cjs, sin DB ni red externa
//   node scripts/run-cloud-tests.mjs --integration   *.integration.cjs contra un PostgreSQL EFÍMERO explícito
//                                                    (BEATGALER_CLOUD_TEST_ADMIN_URL, solo loopback; cada archivo en su base nueva)
//   node scripts/run-cloud-tests.mjs --list [--integration]   muestra la selección sin ejecutar
//
// Seguridad: cada archivo corre en su propio proceso con un entorno construido por allowlist (nunca hereda credenciales),
// cwd en la raíz del repo, `dotenv` inerte (helpers/no-dotenv.cjs: hay módulos que cargan cloud-server/.env por ruta explícita),
// el guard de red del repo precargado (solo loopback), AWS sin configuración y diagnósticos Direct fuera del árbol versionado.
// `postgres-live.integration.cjs` nunca se ejecuta aquí (usa la DATABASE_URL heredada).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "cloud-server", "tests");
const guard = path.join(testsDir, "helpers", "catalog-net-guard.cjs");
const noDotenv = path.join(testsDir, "helpers", "no-dotenv.cjs");
const args = new Set(process.argv.slice(2));
const integration = args.has("--integration");
const listOnly = args.has("--list");

const NEVER = new Set(["postgres-live.integration.cjs"]);
// Orden implícito heredado de CI: este archivo necesita el esquema que deja el anterior en la MISMA base.
const SHARES_DB_WITH = { "direct-persistent-legacy-lazy.postgres.integration.cjs": "direct-vault-assignment.postgres.integration.cjs" };
const ADMIN_URL_VARS = ["BEATGALER_STEP1_TEST_ADMIN_URL", "BEATGALER_STEP2_TEST_ADMIN_URL", "BILLING_CHECKOUT_TEST_ADMIN_URL",
  "BILLING_LIFECYCLE_TEST_ADMIN_URL", "BILLING_E2E_TEST_ADMIN_URL", "BILLING_RECONCILIATION_TEST_ADMIN_URL",
  "BILLING_MIGRATION_TEST_ADMIN_URL", "BILLING_WEBHOOK_TEST_ADMIN_URL"];
const ENV_ALLOW = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP",
  "TMPDIR", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ",
  "CI", "GITHUB_ACTIONS"];

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
  return files.filter((f) => /\.test\.(cjs|mjs)$/.test(f) || f.endsWith(".runner.cjs"));
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
    NODE_OPTIONS: [guard, noDotenv].map((p) => `--require "${p.split(path.sep).join("/")}"`).join(" "),
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
  // En una máquina de desarrollo el 5432 es el clúster de trabajo: nunca se usa. En CI el 5432 es el service container desechable.
  if (port === 5432 && process.env.CI !== "true") fail("el puerto 5432 local es el clúster de desarrollo; usa un clúster efímero propio en otro puerto.");
  return u;
}

async function withAdmin(adminUrl, fn) {
  const requireCloud = createRequire(path.join(root, "cloud-server", "package.json"));
  const { Client } = requireCloud("pg");
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
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

// Archivos locales ignorados por git que contienen credenciales o estado real. Varios módulos los leen o escriben por RUTA FIJA
// junto al código (p. ej. direct-transport-control.js y master-storage.js con master-session.txt; vault-registry.json), así que
// ninguna variable de entorno los aísla: si existen, los tests no se ejecutan en este checkout.
const LOCAL_SECRET_FILES = ["master-session.txt", "transport-bots.local.json", "masters.local.json", "vault-registry.json",
  "accounts-data.json", "cloud-data.json"];

function localSecretFiles() {
  const dir = path.join(root, "cloud-server");
  const found = LOCAL_SECRET_FILES.filter((f) => existsSync(path.join(dir, f)));
  for (const f of readdirSync(dir)) if (/^\.env(\..+)?$/.test(f) && f !== ".env.example") found.push(f);
  return found;
}

async function main() {
  if (existsSync(path.join(root, ".env"))) fail("existe ./.env en la raíz: dotenv lo cargaría en los tests. Muévelo antes de ejecutar.");
  const secrets = localSecretFiles();
  if (secrets.length && !listOnly) {
    fail(`cloud-server/ contiene archivos locales con credenciales o estado real (${secrets.length}; no se leen ni se muestran).\n` +
      "  Ejecuta las pruebas de Cloud desde un worktree limpio, donde no existen:\n" +
      "    git worktree add --detach ../BeatGaler-test HEAD\n" +
      "    (enlazar node_modules y cloud-server/node_modules con junctions; quitarlas con `rmdir` antes de borrar el worktree)\n" +
      "    cd ../BeatGaler-test && npm run test:cloud");
  }
  for (const preload of [guard, noDotenv]) if (!existsSync(preload)) fail(`falta la precarga ${path.relative(root, preload)}`);
  const files = select();
  if (listOnly) { console.log(files.join("\n")); return; }
  console.log(`run-cloud-tests: ${files.length} archivos (${integration ? "integración PostgreSQL efímero" : "unitarios"})`);
  const failed = [];
  if (!integration) {
    for (const f of files) if (!runFile(f, baseEnv(), 300_000)) failed.push(f);
  } else {
    const admin = adminTarget();
    const runId = `${process.pid}_${Date.now().toString(36)}`;
    const created = [];
    const dbFor = {};
    try {
      for (const [i, f] of files.entries()) {
        let db = SHARES_DB_WITH[f] ? dbFor[SHARES_DB_WITH[f]] : null;
        if (!db) {
          db = `bgct_${runId}_${i}`.toLowerCase();
          await withAdmin(admin, (c) => c.query(`CREATE DATABASE "${db}"`));
          created.push(db);
        }
        dbFor[f] = db;
        const adminForTests = new URL(admin); adminForTests.pathname = "/postgres";
        const dbUrl = new URL(admin); dbUrl.pathname = `/${db}`;
        const extra = { DATABASE_URL: dbUrl.toString(), BEATGALER_ALLOW_DESTRUCTIVE_PG_TEST: "true" };
        for (const k of ADMIN_URL_VARS) extra[k] = adminForTests.toString();
        if (!runFile(f, baseEnv(extra), 600_000)) failed.push(f);
      }
    } finally {
      // Solo se borran las bases creadas por esta ejecución.
      await withAdmin(admin, async (c) => { for (const db of created) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {}); }).catch(() => {});
    }
  }
  console.log(`run-cloud-tests: ${files.length - failed.length}/${files.length} PASS${failed.length ? ` · FAIL: ${failed.join(", ")}` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { console.error(`run-cloud-tests: ${error.message}`); process.exitCode = 1; });
