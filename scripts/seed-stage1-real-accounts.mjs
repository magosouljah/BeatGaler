import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env.stage1");
const reportDir = path.join(root, "tmp");
const reportFile = path.join(reportDir, "stage1-real-account-seed-report.json");
const COHORT_SIZE = 10;

if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const cloudUrl = String(process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const cohortId = String(process.env.STAGE1_COHORT_ID || crypto.randomBytes(4).toString("hex")).trim();
const cohortPassword = String(process.env.STAGE1_COHORT_PASSWORD || `Bg1!${crypto.randomBytes(24).toString("base64url")}`).trim();

function upsertEnv(values) {
  const original = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const lines = original.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  const pending = new Map(Object.entries(values));
  const next = lines.map(line => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) next.push(`${key}=${value}`);
  fs.writeFileSync(envFile, `${next.filter(Boolean).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function accountFor(index) {
  const number = String(index).padStart(2, "0");
  return {
    label: number,
    identifier: `stage1.${cohortId}.${number}@beatgaler.test`,
    usernameBase: `s1${cohortId}${number}`.slice(0, 20),
    password: cohortPassword,
    seedInstallationId: `stage1-seed-${cohortId}-${number}`,
  };
}

async function postJson(route, body) {
  const response = await fetch(`${cloudUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

async function preflight() {
  const response = await fetch(`${cloudUrl}/auth/health`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.account_auth !== true) {
    throw new Error(`BeatGaler Cloud account-auth preflight failed at ${cloudUrl}/auth/health.`);
  }
}

async function verifyLogin(account) {
  const login = await postJson("/auth/login", {
    identifier: account.identifier,
    password: account.password,
    beatgalerUserId: account.seedInstallationId,
  });
  if (!login.ok) {
    throw new Error(`Account ${account.label} could not sign in after seed (HTTP ${login.status}: ${String(login.payload?.error || "unknown error")}).`);
  }
  const user = login.payload?.user || {};
  if (!String(user.id || "").trim()) throw new Error(`Account ${account.label} login returned no BeatGaler user id.`);
  if (user.storage_ready !== true) throw new Error(`Account ${account.label} login says storage_ready=false.`);
  return user;
}

async function seedAccount(account) {
  const registration = await postJson("/auth/register", {
    usernameBase: account.usernameBase,
    email: account.identifier,
    password: account.password,
    beatgalerUserId: account.seedInstallationId,
  });

  let state = "CREATED";
  if (!registration.ok) {
    if (registration.status !== 409) {
      throw new Error(`Account ${account.label} registration failed (HTTP ${registration.status}: ${String(registration.payload?.error || "unknown error")}).`);
    }
    state = "EXISTING";
  }

  const user = await verifyLogin(account);
  return {
    label: account.label,
    state,
    identifier: account.identifier,
    user_id: String(user.id),
    username: String(user.username || ""),
    storage_ready: user.storage_ready === true,
  };
}

async function main() {
  upsertEnv({
    STAGE1_COHORT_ID: cohortId,
    STAGE1_COHORT_PASSWORD: cohortPassword,
    STAGE1_COHORT_SIZE: String(COHORT_SIZE),
  });

  console.log(`[stage1-seed] cohort=${cohortId} accounts=${COHORT_SIZE}`);
  console.log("[stage1-seed] password generated/stored locally in ignored .env.stage1; it will not be printed.");
  console.log(`[stage1-seed] cloud=${cloudUrl}`);

  await preflight();
  const seeded = [];
  for (let index = 1; index <= COHORT_SIZE; index += 1) {
    const account = accountFor(index);
    const result = await seedAccount(account);
    seeded.push(result);
    console.log(`[stage1-seed] ${result.label}/10 ${result.state} user=${result.user_id} storage_ready=${result.storage_ready}`);
    if (index < COHORT_SIZE) await new Promise(resolve => setTimeout(resolve, 250));
  }

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify({
    version: 1,
    cohort_id: cohortId,
    cloud_url: cloudUrl,
    account_count: seeded.length,
    seeded_at: new Date().toISOString(),
    accounts: seeded,
  }, null, 2)}\n`, "utf8");

  console.log(`[stage1-seed] PASS ${seeded.length} real BeatGaler accounts are reusable.`);
  console.log(`[stage1-seed] report=${reportFile}`);
}

main().catch(error => {
  console.error(`[stage1-seed] FAIL ${String(error?.message || error)}`);
  process.exit(1);
});
