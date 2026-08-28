import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(root, rel), "utf8");
const fail = message => { throw new Error(`Task 7.2 transport-isolation regression: ${message}`); };

const boundary = read("cloud-server/productive-temp-auth-boundary.js");
const session = read("src/features/cloud/webTransportSession.ts");
const tempAuth = read("src/features/cloud/webTempAuth.ts");
const worker = read("src/features/cloud/webTransport.worker.ts");
const controller = read("src/features/cloud/webTransportController.ts");

// Permanent infrastructure credentials may be consumed only by the controlled
// server binder. Productive client transport modules must reject or omit them.
for (const field of ["bot_token", "telegram_api_id", "telegram_api_hash", "credential_envelope"]) {
  if (!boundary.includes(`${field}: _`)) fail(`controlled binder no longer strips ${field}`);
}
for (const route of ["/transport/session/start", "/transport/session/heartbeat", "/transport/operation/begin"]) {
  if (!boundary.includes(`\"${route}\"`)) fail(`temporary-auth response boundary disappeared from ${route}`);
}
if (!boundary.includes("const safe = stripPermanentSecrets(session);")) fail("session response sanitizer disappeared");
if (!boundary.includes("const { credential_refresh: refresh, ...safeBody } = body")) fail("refresh response reconstruction disappeared");
if (!boundary.includes("originalJson({ ok: false, error: \"Temporary transport authorization is unavailable.\" })")) {
  fail("binder failures can return uncontrolled error material to the client");
}

for (const field of ["bot_token", "telegram_api_id", "telegram_api_hash", "credential_envelope"]) {
  if (!session.includes(`\"${field}\"`)) fail(`client response guard no longer rejects ${field}`);
}
if (!session.includes("function validateBootstrap") || !session.includes("assertNoPermanentCredentials(response);")) {
  fail("bootstrap validation no longer rejects permanent credentials");
}
const identityStart = session.indexOf("function sessionIdentity");
const identityEnd = session.indexOf("async function bindTemporarySession", identityStart);
const identityBlock = session.slice(identityStart, identityEnd);
for (const required of ["sessionId: session.session_id", "generation: session.generation", "credentialVersion: session.credential_version"]) {
  if (!identityBlock.includes(required)) fail(`lease identity lost ${required}`);
}
for (const forbidden of ["temp_auth_key", "temp_primary_dcs", "bot_token", "telegram_api_hash", "telegram_api_id"]) {
  if (identityBlock.includes(forbidden)) fail(`lease identity serializes forbidden credential material: ${forbidden}`);
}

if (!worker.includes("apiId: 0") || !worker.includes('apiHash: ""')) fail("Worker can receive productive API credentials again");
for (const forbidden of ["bot_token", "telegram_api_hash", "telegram_api_id", "credential_envelope"]) {
  if (worker.includes(forbidden)) fail(`Worker source contains permanent credential surface: ${forbidden}`);
}
if (!worker.includes("storage: new MemoryStorage()")) fail("temporary transport Worker no longer uses memory-only session storage");
if (!worker.includes("temp_auth_key.fill(0);")) fail("Worker no longer zeroizes its structured-cloned temporary key after import");

for (const [name, source] of [["webTempAuth", tempAuth], ["webTransportSession", session], ["webTransportController", controller], ["webTransport.worker", worker]]) {
  for (const persistence of ["localStorage", "sessionStorage", "indexedDB"]) {
    if (source.includes(persistence)) fail(`${name} persists transport authorization through ${persistence}`);
  }
}
if (!tempAuth.includes("export const PRODUCTIVE_TEMP_AUTH_TTL_SECONDS = 10 * 60")) fail("productive temporary-auth TTL is no longer explicitly bounded to ten minutes");
if (!tempAuth.includes("authKeyBytes?.fill(0)") || !tempAuth.includes("authKeyBytes = null")) fail("temporary-auth producer no longer zeroizes its owned key material on destroy/error");

const browserTransport = `${session}\n${tempAuth}\n${worker}\n${controller}`;
const credentialLog = /console\.(?:log|info|warn|error|debug)\([^\n]*(?:bot_token|telegram_api_hash|telegram_api_id|credential_envelope|temp_auth_key)/i;
if (credentialLog.test(browserTransport)) fail("browser transport directly logs credential material");

const dist = path.join(root, "dist");
if (existsSync(dist)) {
  const pending = [dist];
  const forbiddenBuiltNames = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_API_HASH",
    "BEATGALER_TELEGRAM_API_HASH",
    "BEATGALER_TRANSPORT_BOT_TOKEN",
  ];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (/\.(?:js|html)$/i.test(entry.name)) {
        const built = readFileSync(full, "utf8");
        for (const forbidden of forbiddenBuiltNames) {
          if (built.includes(forbidden)) fail(`compiled client contains infrastructure secret surface ${forbidden} in ${entry.name}`);
        }
      }
    }
  }
}

console.log("PASS Task 7.2 client isolation: permanent bot/API credentials stay server-side; temporary auth remains memory-only, bounded, and zeroized");
