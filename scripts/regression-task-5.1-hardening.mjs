import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(root, rel), "utf8");
const fail = message => { throw new Error(`Task 5.1 hardening regression: ${message}`); };

const vite = read("vite.config.ts");
const main = read("src/main.tsx");
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
const serverCore = read("cloud-server/server-core.js");
const server = read("cloud-server/server.js");
const headers = read("cloud-server/security-headers.js");
const tempAuthBoundary = read("cloud-server/productive-temp-auth-boundary.js");

if (!vite.includes("beatgaler-productive-trust-boundary")) fail("productive Vite trust-boundary transform is missing");
if (!vite.includes("refusing an unsafe build") || !vite.includes("trustedRememberedApi")) fail("cloud-origin transform is not fail-closed");
if (!vite.includes("safeId3Loader") || !vite.includes("unsafeId3Loader")) fail("remote ID3 loader stripping is missing");
if (!main.includes('browserId3Reader') || !main.includes('(window as any).jsmediatags = browserId3Reader')) fail("local browser ID3 parser is not installed before app render");

const csp = String(tauri?.app?.security?.csp || "");
if (!csp) fail("Tauri CSP is disabled");
if (!csp.includes("script-src 'self'")) fail("Tauri CSP permits non-self scripts");
if (!csp.includes("object-src 'none'")) fail("Tauri CSP does not disable object embedding");
if (!csp.includes("frame-ancestors 'none'")) fail("Tauri CSP does not deny framing");

const permissions = new Set(capabilities.permissions || []);
for (const required of ["fs:allow-write-file", "fs:allow-read-dir", "fs:allow-remove", "fs:allow-mkdir", "fs:scope-app-recursive"]) {
  if (!permissions.has(required)) fail(`drop-staging permission disappeared: ${required}`);
}
for (const forbidden of ["fs:default", "fs:allow-create", "fs:allow-rename", "fs:allow-exists", "fs:allow-stat", "fs:allow-app-write-recursive"]) {
  if (permissions.has(forbidden)) fail(`unnecessary filesystem permission returned: ${forbidden}`);
}

if (!serverCore.includes("BEATGALER_ALLOWED_ORIGINS")) fail("Cloud CORS allowlist disappeared");
if (serverCore.includes("Access-Control-Allow-Credentials")) fail("Cloud CORS must not enable credentialed cookies");
if (!server.includes("installSecurityHeaders(express)")) fail("API security-header bootstrap is not installed");
for (const header of ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Content-Security-Policy", "Cache-Control"]) {
  if (!headers.includes(header)) fail(`API security header missing: ${header}`);
}

if (!tempAuthBoundary.includes("serializePermanentAuthorization")) fail("fresh permanent bot authorizations are no longer globally serialized");
if (!tempAuthBoundary.includes("const { credential_refresh: refresh, ...safeBody } = body")) fail("credential refresh is no longer stripped before safe reconstruction");
const noMetadataBranch = tempAuthBoundary.slice(
  tempAuthBoundary.indexOf("if (!metadata) {", tempAuthBoundary.indexOf("async function transformTransportBody")),
  tempAuthBoundary.indexOf("return {", tempAuthBoundary.indexOf("if (!metadata) {", tempAuthBoundary.indexOf("async function transformTransportBody")) + 20),
);
if (noMetadataBranch.includes("credential_refresh")) fail("refresh without temp metadata can expose a nullable/unsafe credential_refresh field");

const dist = path.join(root, "dist");
if (existsSync(dist)) {
  const pending = [dist];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (/\.(?:js|html)$/i.test(entry.name)) {
        const built = readFileSync(full, "utf8");
        if (built.includes("http://127.0.0.1:4000")) fail(`compiled frontend still discovers local Cloud at ${entry.name}`);
        if (built.includes("cdn.jsdelivr.net/npm/jsmediatags")) fail(`compiled frontend still contains remote ID3 JavaScript loader at ${entry.name}`);
      }
    }
  }
}

console.log("PASS Task 5.1 hardening: fixed Cloud origin, local ID3, CSP/CORS headers, reduced Tauri FS scopes, safe refresh, and serialized permanent auth");
