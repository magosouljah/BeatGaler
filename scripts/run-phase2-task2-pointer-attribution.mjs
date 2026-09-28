import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloudDir = path.join(root, "cloud-server");
const rawReport = path.join(root, "tmp", "stage1-real-multi-account-report.json");
const task4Report = path.join(root, "tmp", "stage1-task-4-five-account-report.json");
const cloudPort = "4010";
const cloudUrl = `http://127.0.0.1:${cloudPort}`;
const startedAt = new Date().toISOString();
const experimentId = startedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
const resultDir = path.join(root, "tmp", "phase2-task2", experimentId);
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
    const response = await fetch(`${cloudUrl}/readyz`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return response.status === 200 && body?.ok === true && body?.dependencies?.postgres === "ready";
  } catch { return false; }
}

async function startCloud() {
  try {
    await fetch(`${cloudUrl}/auth/health`, { signal: AbortSignal.timeout(1500) });
    throw new Error(`Ya existe Cloud en :${cloudPort}; Task 2 debe arrancarlo desde este checkout.`);
  } catch (error) {
    if (error?.message?.startsWith("Ya existe Cloud")) throw error;
  }
  await fs.access(path.join(cloudDir, ".env"));
  cloud = spawn(process.execPath, ["--env-file=.env", "server.js"], {
    cwd: cloudDir,
    env: { ...process.env, PORT: cloudPort },
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
      const values = rows.map(row => {
        const value = row?.durations_ms?.[name];
        return value === null || value === undefined ? Number.NaN : Number(value);
      });
      const clean = values.filter(Number.isFinite);
      return [name, { samples: clean.length, avg_ms: clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null, p95_ms: percentile(clean), max_ms: clean.length ? Math.max(...clean) : null }];
    }));
    output[condition] = {
      samples: rows.length,
      accounts: rows.map(row => row.account_label).sort(),
      complete: rows.every(row => row.complete === true),
      durations,
      rpc_attribution_by_account: rows.map(row => ({
        account_label: row.account_label,
        pointer_lookup_ms: row.durations_ms?.pointer_lookup ?? null,
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
      passive_ping_by_account: rows.map(row => {
        const timeline = (Array.isArray(row.task2_passive_ping_timeline) ? row.task2_passive_ping_timeline : [])
          .sort((left, right) => Number(left.absolute_ms) - Number(right.absolute_ms));
        const first = stage => timeline.find(event => event.stage === stage) || null;
        const getMessagesBegin = first("TASK2_PING_GET_MESSAGES_BEGIN");
        const pingSent = first("TASK2_PING_PING_SENT");
        const pongBeforeGetMessages = timeline.find(event =>
          event.stage === "TASK2_PING_PONG_RECEIVED" &&
          Number(event.absolute_ms) <= Number(getMessagesBegin?.absolute_ms),
        ) || null;
        const pongAfterPing = timeline.find(event =>
          event.stage === "TASK2_PING_PONG_RECEIVED" &&
          Number(event.absolute_ms) >= Number(pingSent?.absolute_ms),
        ) || null;
        const resetAfterPing = timeline.find(event =>
          event.stage === "TASK2_PING_RESET_SESSION" &&
          Number(event.absolute_ms) >= Number(pingSent?.absolute_ms),
        ) || null;
        const elapsed = (left, right) => Number.isFinite(left?.absolute_ms) && Number.isFinite(right?.absolute_ms)
          ? Number(right.absolute_ms) - Number(left.absolute_ms)
          : null;
        return {
          account_label: row.account_label,
          connection_id: timeline.find(event => event.detail?.connection_id)?.detail?.connection_id || null,
          events: timeline,
          at_get_messages_begin: getMessagesBegin?.detail || null,
          last_ping_pending_at_get_messages_begin: getMessagesBegin
            ? getMessagesBegin.detail?.last_ping_pending === true
            : null,
          pong_received_before_get_messages: getMessagesBegin
            ? Boolean(pongBeforeGetMessages)
            : null,
          ping_sent_to_pong_ms: elapsed(pingSent, pongAfterPing),
          ping_sent_to_reset_ms: elapsed(pingSent, resetAfterPing),
        };
      }),
      dominant_by_account: rows.map(row => {
        const entries = Object.entries(row.durations_ms || {}).filter(([name, value]) => name !== "total" && Number.isFinite(Number(value)));
        entries.sort((left, right) => Number(right[1]) - Number(left[1]));
        return { account_label: row.account_label, span: entries[0]?.[0] || null, duration_ms: entries[0]?.[1] ?? null, total_ms: row.durations_ms?.total ?? null };
      }),
      mtproto_get_messages_diagnosis_by_account: rows.map(row => {
        const timeline = [
          ...(Array.isArray(row.pointer_get_messages_timeline) ? row.pointer_get_messages_timeline : []),
          ...((row.mtproto_timeline || []).filter(event =>
            /^(?:WORKER_MTPROTO_(?:CONNECTION_STATE|DISCONNECTED|RECONNECT_(?:BEGIN|READY)|SESSION_RESET|CLIENT_ERROR))$/.test(event.stage) &&
            event.detail?.rpc_context?.stage === "WORKER_INDEX_POINTER_GET_MESSAGES",
          )),
        ].filter((event, index, all) => all.findIndex(other => other.stage === event.stage && other.absolute_ms === event.absolute_ms) === index)
          .sort((left, right) => Number(left.absolute_ms) - Number(right.absolute_ms));
        const before = timeline.find(event => event.stage === "WORKER_INDEX_POINTER_GET_MESSAGES_BEGIN") || null;
        const sent = timeline.find(event => event.stage === "WORKER_INDEX_POINTER_GET_MESSAGES_RPC_SENT") || null;
        const reconnectBegin = timeline.find(event => event.stage === "WORKER_MTPROTO_RECONNECT_BEGIN") || null;
        const reconnectReady = timeline.find(event => event.stage === "WORKER_MTPROTO_RECONNECT_READY") || null;
        const response = timeline.find(event => event.stage === "WORKER_INDEX_POINTER_GET_MESSAGES_RPC_RESPONSE_RECEIVED") || null;
        const end = timeline.find(event => event.stage === "WORKER_INDEX_POINTER_GET_MESSAGES_END") || null;
        const duration = (left, right) => Number.isFinite(left?.absolute_ms) && Number.isFinite(right?.absolute_ms)
          ? right.absolute_ms - left.absolute_ms
          : null;
        return {
          account_label: row.account_label,
          cloud_direct_lease: row.cloud_session_start?.map(item => item.direct_lease_selection).filter(Boolean) || [],
          direct_session_ids: row.cloud_session_start?.map(item => item.direct_session_id).filter(Boolean) || [],
          worker_client_ids: (row.mtproto_timeline || [])
            .filter(event => event.stage === "WORKER_MTPROTO_CLIENT_CREATED")
            .map(event => event.detail?.client_instance_id)
            .filter(Boolean),
          connection_before_get_messages: before?.detail || null,
          reconnect_observed: Boolean(reconnectBegin),
          durations_ms: {
            before_rpc_send: duration(before, sent),
            reconnect: duration(reconnectBegin, reconnectReady),
            after_reconnect_to_response: duration(reconnectReady, response),
            rpc_send_to_response: duration(sent, response),
            get_messages_total: duration(before, end),
          },
          timeline,
        };
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
  configuration: { accounts: 5, web_mode: "vite-preview", cloud: "managed local PostgreSQL Cloud", task0_repeated: false, task2_passive_ping_trace: true },
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
      STAGE1_CLOUD_URL: cloudUrl,
      STAGE1_RUN_ACCOUNTS: "5",
      STAGE1_WEB_PORT: "1421",
      PHASE2_TASK1_ATTRIBUTION: "1",
      PHASE2_TASK2_POINTER_ATTRIBUTION: "1",
      PHASE2_TASK2_PASSIVE_PING_TRACE: "1",
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
  const passivePingComplete = ["apertura_fria", "reload_caliente"].every(condition =>
    summary.evidence[condition]?.passive_ping_by_account?.every(item =>
      item.events.some(event => event.stage === "TASK2_PING_GET_MESSAGES_BEGIN") &&
      item.events.some(event => event.stage === "TASK2_PING_GET_MESSAGES_END"),
    ),
  );
  const valid = !scenarioError && report?.overall === "PASS" && ["apertura_fria", "reload_caliente"].every(condition =>
    summary.evidence[condition]?.samples === 5 && summary.evidence[condition]?.complete,
  ) && passivePingComplete;
  summary.status = valid ? "ATTRIBUTION_COMPLETE" : "INSUFFICIENT_EVIDENCE";
  summary.reason = valid
    ? null
    : scenarioError || (!passivePingComplete
      ? "La traza pasiva de ping no lleg� completa para las diez operaciones getMessages."
      : "La corrida no produjo diez l�neas de tiempo completas y ordenadas.");
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
  console.log(`[phase2-task2] ${summary.status} ${path.join(resultDir, "summary.json")}`);
}

process.exitCode = summary.status === "ATTRIBUTION_COMPLETE" ? 0 : 1;
