import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePhase2Task0Run, validateDirectPostgresPreflight } from "./phase2-task0-report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawReport = path.join(root, "tmp", "stage1-real-multi-account-report.json");
const fixedReports = [rawReport, path.join(root, "tmp", "stage1-task-4-five-account-report.json")];
const cloudEnvFile = path.join(root, "cloud-server", ".env");
const preflightOnly = process.argv.includes("--preflight-only");
const runsArg = process.argv.indexOf("--runs");
const runCount = runsArg < 0 ? 3 : Number(process.argv[runsArg + 1]);
if (!Number.isInteger(runCount) || runCount < 1 || runCount > 20) {
  console.error("Uso: node scripts/run-phase2-task0-measurements.mjs [--runs 1..20]");
  process.exit(2);
}

const startedAt = new Date().toISOString();
const experimentId = startedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
const resultDir = path.join(root, "tmp", "phase2-task0", experimentId);
const summary = {
  schema_version: 1,
  experiment_id: experimentId,
  started_at: startedAt,
  finished_at: null,
  target: { runs: 3, accounts: 5, samples_per_metric_per_run: 20, web_mode: "vite-preview" },
  actual: { requested_runs: runCount, completed_runs: 0 },
  identity: null,
  preflight: null,
  runs: [],
  status: "BLOCKED",
  reason: null,
};
let cloud = null;
const previousReports = new Map();

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function sourceFingerprint() {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
    .toString("utf8").split("\0")
    .filter(relative => /\.(?:cjs|css|html|js|json|mjs|ts|tsx)$/.test(relative) && !relative.startsWith("tmp/"))
    .sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    const bytes = await fs.readFile(path.join(root, relative)).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hash.update(relative).update("\0");
    hash.update(bytes ?? "<deleted>").update("\0");
  }
  return hash.digest("hex");
}

async function directoryFingerprint(directory) {
  const hash = createHash("sha256");
  async function visit(current, prefix = "") {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
      else if (entry.isFile()) hash.update(relative).update("\0").update(await fs.readFile(path.join(current, entry.name))).update("\0");
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && command === "npm", ...options });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${command} terminó con código ${code}.`)));
  });
}

async function healthyCloud() {
  try {
    const response = await fetch("http://127.0.0.1:4000/auth/health", { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return response.ok && body?.account_auth === true;
  } catch { return false; }
}

async function postgresReadyCloud() {
  try {
    const response = await fetch("http://127.0.0.1:4000/readyz", { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return {
      status: response.status,
      ok: response.status === 200 && body?.ok === true && body?.dependencies?.postgres === "ready",
      postgres: body?.dependencies?.postgres || "unknown",
    };
  } catch {
    return { status: null, ok: false, postgres: "unavailable" };
  }
}

async function startCloud() {
  if (await healthyCloud()) throw new Error("Ya existe Cloud en :4000. Deténgalo: el protocolo debe arrancar Cloud desde este checkout.");
  await fs.access(cloudEnvFile).catch(() => { throw new Error("Falta cloud-server/.env para arrancar el Cloud PostgreSQL de Stage 1."); });
  // server.js reads PostgreSQL settings before server-core.js calls dotenv.
  // Node must load the same Cloud .env before evaluating server.js.
  cloud = spawn(process.execPath, ["--env-file=.env", "server.js"], {
    cwd: path.join(root, "cloud-server"),
    env: { ...process.env, PORT: "4000" },
    stdio: "inherit",
    shell: false,
  });
  summary.identity.cloud_pid = cloud.pid;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (cloud.exitCode !== null) throw new Error(`Cloud terminó durante el arranque (código ${cloud.exitCode}).`);
    if (await healthyCloud()) {
      const ready = await postgresReadyCloud();
      if (ready.ok) return ready;
      throw new Error(`Cloud arrancó sin PostgreSQL listo (/readyz=${ready.status ?? "sin respuesta"}, postgres=${ready.postgres}).`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Cloud no respondió con auth/health saludable en 90 s.");
}

async function saveSummary() {
  summary.finished_at = new Date().toISOString();
  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(path.join(resultDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

async function stage1(mode, ordinal, identity) {
  await fs.rm(rawReport, { force: true });
  const env = {
    ...process.env,
    STAGE1_WEB_PREVIEW: "1",
    STAGE1_CLOUD_URL: "http://127.0.0.1:4000",
    STAGE1_WORKTREE_FINGERPRINT: identity.source_sha256,
    STAGE1_RUN_ACCOUNTS: "5",
    STAGE1_WEB_PORT: "1421",
    STAGE1_FOCUSED_STARTUP: mode === "startup" ? "1" : "0",
    PHASE2_TASK0_MEASUREMENT: mode === "measurement" ? "1" : "0",
    STAGE1_FOCUSED_LIFECYCLE: "0",
    STAGE1_FOCUSED_DOWNLOAD_INTEGRITY: "0",
    STAGE1_FOCUSED_ISOLATION: "0",
    STAGE1_MIXED_WORKLOAD: "0",
    STAGE1_SOAK_MINUTES: "0",
    STAGE1_FOCUSED_FINAL_RELOAD_TRACE: "0",
    STAGE1_SINGLE_RELOAD_ATTRIBUTION_TRACE: "0",
    STAGE1_TASK5_ONE_ACCOUNT_FAILURES: "0",
    STAGE1_TASK6_FINAL_VERIFICATION: "0",
  };
  let commandError = null;
  try {
    await runCommand(process.execPath, [path.join(root, "scripts", "run-stage1-real-multi-account-e2e.mjs"), "--accounts", "5"], { env });
  } catch (error) { commandError = error.message; }
  const destination = path.join(resultDir, `run-${String(ordinal).padStart(2, "0")}-${mode}-raw.json`);
  let report = null;
  try {
    report = JSON.parse(await fs.readFile(rawReport, "utf8"));
    await fs.copyFile(rawReport, destination);
  } catch { /* Missing report is an invalid run, never a pass. */ }
  return { report, commandError, file: report ? path.relative(root, destination).replaceAll("\\", "/") : null };
}

try {
  await fs.mkdir(resultDir, { recursive: true });
  for (const file of fixedReports) {
    const prior = await fs.readFile(file).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    previousReports.set(file, prior);
    if (prior) await fs.writeFile(path.join(resultDir, `previous-${path.basename(file)}`), prior);
  }
  const identity = {
    head: git("rev-parse", "HEAD"),
    source_sha256: await sourceFingerprint(),
    web_dist_sha256: null,
    cloud_origin: "managed child process: node --env-file=.env cloud-server/server.js from this checkout",
    node_version: process.version,
  };
  summary.identity = identity;
  await runCommand("npm", ["run", "build:web"]);
  if (await sourceFingerprint() !== identity.source_sha256) throw new Error("El código fuente cambió durante el build.");
  identity.web_dist_sha256 = await directoryFingerprint(path.join(root, "dist"));
  const ready = await startCloud();
  summary.preflight = { readyz: ready, session_start: null, report: null, command_error: null };
  if (preflightOnly) {
    const directProbe = await stage1("startup", 0, identity);
    summary.preflight.session_start = validateDirectPostgresPreflight(directProbe.report);
    summary.preflight.report = directProbe.file;
    summary.preflight.command_error = directProbe.commandError;
    if (!summary.preflight.session_start.ok) {
      throw new Error("Preflight Direct/PostgreSQL falló; no se aceptan muestras de Task 0.");
    }
    summary.status = "POSTGRES_DIRECT_VERIFIED";
  } else {
  for (let ordinal = 1; ordinal <= runCount; ordinal += 1) {
    if (cloud.exitCode !== null || !(await healthyCloud()) || !(await postgresReadyCloud()).ok) throw new Error("Cloud/PostgreSQL no está disponible antes de la corrida.");
    if (git("rev-parse", "HEAD") !== identity.head || await sourceFingerprint() !== identity.source_sha256 || await directoryFingerprint(path.join(root, "dist")) !== identity.web_dist_sha256) {
      throw new Error("El código fuente o el build Web cambió entre corridas.");
    }
    const measurement = await stage1("measurement", ordinal, identity);
    const directProof = validateDirectPostgresPreflight(measurement.report);
    if (ordinal === 1) {
      summary.preflight.session_start = directProof;
      summary.preflight.report = measurement.file;
      summary.preflight.command_error = measurement.commandError;
    }
    const normalized = normalizePhase2Task0Run({ report: measurement.report, runId: ordinal, identity });
    normalized.raw_report = measurement.file;
    normalized.command_error = measurement.commandError;
    normalized.direct_postgres_proof = directProof;
    if (measurement.commandError || !directProof.ok) {
      normalized.validity.status = "INVALID";
      normalized.validity.reasons.push("El E2E o la comprobación Direct/PostgreSQL terminó con error.");
    }
    if (git("rev-parse", "HEAD") !== identity.head || await sourceFingerprint() !== identity.source_sha256 || await directoryFingerprint(path.join(root, "dist")) !== identity.web_dist_sha256) {
      normalized.validity.status = "INVALID";
      normalized.validity.reasons.push("El código fuente o el build cambió durante la corrida.");
    }
    const file = path.join(resultDir, `run-${String(ordinal).padStart(2, "0")}-normalized.json`);
    await fs.writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`);
    summary.runs.push({
      ordinal,
      report: path.relative(root, file).replaceAll("\\", "/"),
      status: normalized.validity.status,
      reasons: normalized.validity.reasons,
      statistics: normalized.statistics,
      errors: normalized.errors.length,
    });
    summary.actual.completed_runs += 1;
    await saveSummary();
  }
  summary.status = summary.runs.every(run => run.status === "VALID")
    ? runCount >= 3 ? "BASELINE_COMPLETE" : "VALID_RUN"
    : "INSUFFICIENT_EVIDENCE";
  summary.reason = summary.status === "INSUFFICIENT_EVIDENCE" ? "Una o más condiciones carecen de cinco cuentas y timestamps completos." : null;
  }
} catch (error) {
  summary.status = "BLOCKED";
  summary.reason = error.message;
  console.error(`[phase2-task0] ${error.message}`);
} finally {
  if (cloud && cloud.exitCode === null) cloud.kill("SIGTERM");
  for (const [file, prior] of previousReports) {
    if (prior) await fs.writeFile(file, prior);
    else await fs.rm(file, { force: true });
  }
  await saveSummary();
  console.log(`[phase2-task0] ${summary.status} ${path.join(resultDir, "summary.json")}`);
}
process.exitCode = ["VALID_RUN", "BASELINE_COMPLETE", "POSTGRES_DIRECT_VERIFIED"].includes(summary.status) ? 0 : 1;
