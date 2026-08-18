import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareSemver,
  validateStaticUpdaterManifest,
  validateUpdaterActivationConfig,
} from "./updater-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = message => { throw new Error(`Phase 12 regression failed: ${message}`); };
const rust = fs.readFileSync(path.join(root, "src-tauri", "src", "versioning.rs"), "utf8");
const commands = fs.readFileSync(path.join(root, "src-tauri", "src", "commands.rs"), "utf8");

if (!rust.includes("pub const SQLITE_SCHEMA_VERSION: i64 = 2")) fail("SQLite schema version did not advance to v2.");
if (!rust.includes("transaction_with_behavior(TransactionBehavior::Immediate)")) fail("SQLite migrations are not transactional.");
if (!rust.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) fail("Migration ledger disappeared.");
if (!rust.includes("current > SQLITE_SCHEMA_VERSION")) fail("Future SQLite schemas are no longer rejected.");
if (!rust.includes("tx.pragma_update(None, \"user_version\", SQLITE_SCHEMA_VERSION)")) fail("user_version is not committed inside the migration transaction.");
if (!commands.includes("migrate_sqlite_schema(&mut conn)?")) fail("init_db bypasses the migration runner.");
if (commands.includes("finalize_sqlite_schema_version(&conn)")) fail("Legacy non-transactional schema finalization returned.");

if (compareSemver("0.6.2", "0.6.1") <= 0) fail("SemVer comparison cannot detect upgrades.");
if (compareSemver("0.6.1", "0.6.2") >= 0) fail("SemVer comparison allows downgrade ordering.");

const valid = {
  version: "0.6.2",
  notes: "migration test",
  pub_date: "2026-08-18T12:00:00Z",
  platforms: {
    "windows-x86_64": {
      signature: "dGVzdC1zaWduYXR1cmUtY29udGVudC10aGF0LWlzLW5vdC1hLXBhdGg=",
      url: "https://updates.example.test/BeatGaler-0.6.2.nsis.zip",
    },
  },
};
validateStaticUpdaterManifest(valid, { currentVersion: "0.6.1" });

for (const bad of [
  { ...valid, version: "0.6.1" },
  { ...valid, version: "0.6.0" },
  { ...valid, platforms: { "windows-x86_64": { ...valid.platforms["windows-x86_64"], url: "http://updates.example.test/app.zip" } } },
  { ...valid, platforms: { "windows-x86_64": { ...valid.platforms["windows-x86_64"], signature: "https://updates.example.test/app.sig" } } },
  { ...valid, platforms: { "windows-amd64": valid.platforms["windows-x86_64"] } },
]) {
  let rejected = false;
  try { validateStaticUpdaterManifest(bad, { currentVersion: "0.6.1" }); } catch { rejected = true; }
  if (!rejected) fail("Unsafe updater manifest was accepted.");
}

validateUpdaterActivationConfig({
  endpoint: "https://updates.example.test/latest.json",
  pubkey: "PUBLIC-KEY-ONLY-0123456789abcdefghijklmnopqrstuvwxyz",
});
let privateKeyRejected = false;
try {
  validateUpdaterActivationConfig({
    endpoint: "https://updates.example.test/latest.json",
    pubkey: "-----BEGIN PRIVATE KEY----- definitely-not-allowed -----END PRIVATE KEY-----",
  });
} catch { privateKeyRejected = true; }
if (!privateKeyRejected) fail("Updater activation accepts a private signing key.");

console.log("PASS Phase 12 migrations/updater contract: SQLite upgrades are transactional/fail-closed and update manifests reject downgrade, HTTP, bad targets, URL signatures, and private keys");
