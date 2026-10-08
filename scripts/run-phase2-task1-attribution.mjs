import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloudDir = path.join(root, "cloud-server");
const rawReport = path.join(root, "tmp", "stage1-real-multi-account-report.json");
const task4Report = path.join(root, "tmp", "stage1-task-4-five-account-report.json");
const startedAt = new Date().toISOString();
const experimentId = startedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
const resultDir = path.join(root, "tmp", "phase2-task1", experimentId);
let cloud = null;
const previousReports = new Map();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32" && command === "npm",
      ...options,
    });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${command} terminó con código ${code}.`)));
  });
}

async function fingerprint(directory) {
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

async function ready() {
  try {
    const response = await fetch("http://127.0.0.1:4000/readyz", { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return response.status === 200 && body?.ok === true && body?.dependencies?.postgres === "ready";
  } catch { return false; }
}

async function startCloud() {
  try {
    await fetch("http://127.0.0.1:4000/auth/health", { signal: AbortSignal.timeout(1500) });
    throw new Error("Ya existe Cloud en :4000; Task 1 debe arrancarlo desde este checkout.");
  } catch (error) {
    if (error?.message?.startsWith("Ya existe Cloud")) throw error;
  }
  await fs.access(path.join(cloudDir, ".env"));
  cloud = spawn(process.execPath, ["--env-file=.env", "server.js"], {
    cwd: cloudDir,
    env: { ...process.env, PORT: "4000" },
    stdio: "inherit",
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (cloud.exitCode !== null) throw new Error(`Cloud terminó durante el arranque (código ${cloud.exitCode}).`);
    if (await ready()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Cloud/PostgreSQL no alcanzó /readyz en 90 s.");
}

function percentile(values, fraction = 0.95) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(report) {
  const samples = report?.phase2_task1?.samples || {};
  const output = {};
  for (const condition of ["apertura_fria", "reload_caliente"]) {
    const rows = Array.isArray(samples[condition]) ? samples[condition] : [];
    const durationNames = Object.keys(rows[0]?.durations_ms || {});
    const durations = Object.fromEntries(durationNames.map(name => {
      const values = rows.map(row => Number(row?.durations_ms?.[name]));
      return [name, { samples: values.filter(Number.isFinite).length, avg_ms: values.reduce((sum, value) => sum + value, 0) / values.length, p95_ms: percentile(values), max_ms: Math.max(...values) }];
    }));
    output[condition] = {
      samples: rows.length,
      accounts: rows.map(row => row.account_label).sort(),
      complete: rows.every(row => row.complete === true),
      durations,
      rpc_attribution_by_account: rows.map(row => ({
        account_label: row.account_label,
        get_chat_ms: {
          total: row.durations_ms?.get_chat_total ?? null,
          before_rpc: row.durations_ms?.get_chat_antes_rpc ?? null,
          rpc: row.durations_ms?.get_chat_rpc ?? null,
          local_after_rpc: row.durations_ms?.get_chat_procesamiento_local ?? null,
        },
        get_full_chat_ms: {
          total: row.durations_ms?.get_full_chat_total ?? null,
          before_rpc: row.durations_ms?.get_full_chat_antes_rpc ?? null,
          rpc: row.durations_ms?.get_full_chat_rpc ?? null,
          local_after_rpc: row.durations_ms?.get_full_chat_procesamiento_local ?? null,
        },
        rest_of_get_index_ms: row.durations_ms?.resto_get_index ?? null,
        get_index_retries: row.retries_y_reconexiones?.get_index_attempt_failures?.length ?? null,
        reconnects: row.retries_y_reconexiones?.connection_state_events
          ?.filter(event => event.detail?.reconnect === true).length ?? null,
        mtproto_errors: row.retries_y_reconexiones?.mtproto_client_errors?.length ?? null,
      })),
      dominant_by_account: rows.map(row => {
        const entries = Object.entries(row.durations_ms || {}).filter(([name, value]) => name !== "total" && Number.isFinite(Number(value)));
        entries.sort((left, right) => Number(right[1]) - Number(left[1]));
        return { account_label: row.account_label, span: entries[0]?.[0] || null, duration_ms: entries[0]?.[1] ?? null, total_ms: row.durations_ms?.total ?? null };
      }),
    };
  }
  return output;
}

const summary = {
  schema_version: 1,
  experiment_id: experimentId,
  started_at: startedAt,
  finished_at: null,
  configuration: { accounts: 5, web_mode: "vite-preview", cloud: "managed local PostgreSQL Cloud", task0_repeated: false },
  identity: null,
  evidence: null,
  status: "BLOCKED",
  reason: null,
};

try {
  await fs.mkdir(resultDir, { recursive: true });
  for (const file of [rawReport, task4Report]) {
    const content = await fs.readFile(file).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    previousReports.set(file, content);
  }
  await run("npm", ["run", "build:web"]);
  summary.identity = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    web_dist_sha256: await fingerprint(path.join(root, "dist")),
    node_version: process.version,
  };
  await startCloud();
  await fs.rm(rawReport, { force: true });
  let scenarioError = null;
  try {
    await run(process.execPath, [path.join(root, "scripts", "run-stage1-real-multi-account-e2e.mjs"), "--accounts", "5"], {
      env: {
      ...process.env,
      STAGE1_WEB_PREVIEW: "1",
      STAGE1_CLOUD_URL: "http://127.0.0.1:4000",
      STAGE1_RUN_ACCOUNTS: "5",
      STAGE1_WEB_PORT: "1421",
      PHASE2_TASK1_ATTRIBUTION: "1",
      PHASE2_TASK0_MEASUREMENT: "0",
      STAGE1_FOCUSED_STARTUP: "0",
      STAGE1_FOCUSED_LIFECYCLE: "0",
      STAGE1_FOCUSED_DOWNLOAD_INTEGRITY: "0",
      STAGE1_FOCUSED_ISOLATION: "0",
      STAGE1_MIXED_WORKLOAD: "0",
      STAGE1_SOAK_MINUTES: "0",
      STAGE1_FOCUSED_FINAL_RELOAD_TRACE: "0",
      STAGE1_SINGLE_RELOAD_ATTRIBUTION_TRACE: "0",
      STAGE1_TASK5_ONE_ACCOUNT_FAILURES: "0",
      STAGE1_TASK6_FINAL_VERIFICATION: "0",
      },
    });
  } catch (error) {
    scenarioError = error instanceof Error ? error.message : String(error);
  }
  const reportText = await fs.readFile(rawReport, "utf8").catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!reportText) throw new Error(scenarioError || "El E2E no escribió su reporte crudo.");
  const report = JSON.parse(reportText);
  await fs.writeFile(path.join(resultDir, "attribution-raw.json"), reportText);
  summary.evidence = summarize(report);
  const valid = !scenarioError && report?.overall === "PASS" && ["apertura_fria", "reload_caliente"].every(condition =>
    summary.evidence[condition]?.samples === 5 && summary.evidence[condition]?.complete,
  );
  summary.status = valid ? "ATTRIBUTION_COMPLETE" : "INSUFFICIENT_EVIDENCE";
  summary.reason = valid ? null : scenarioError || "La corrida no produjo diez líneas de tiempo completas y ordenadas.";
} catch (error) {
  summary.reason = error instanceof Error ? error.message : String(error);
} finally {
  if (cloud && cloud.exitCode === null) cloud.kill("SIGTERM");
  for (const [file, content] of previousReports) {
    if (content) await fs.writeFile(file, content);
    else await fs.rm(file, { force: true });
  }
  summary.finished_at = new Date().toISOString();
  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(path.join(resultDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[phase2-task1] ${summary.status} ${path.join(resultDir, "summary.json")}`);
}

process.exitCode = summary.status === "ATTRIBUTION_COMPLETE" ? 0 : 1;
