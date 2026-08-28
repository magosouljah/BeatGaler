import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const json = (relative) => JSON.parse(read(relative));

function fail(message) {
  throw new Error(`Upgrade matrix mismatch: ${message}`);
}
function expect(condition, message) {
  if (!condition) fail(message);
}

const matrix = json("release/upgrade-matrix.json");
const releaseManifest = json(matrix.target.releaseManifest);
const tauri = json("src-tauri/tauri.conf.json");
const upgradeRust = read("src-tauri/src/upgrade.rs");
const rustLib = read("src-tauri/src/lib.rs");
const rustCommands = read("src-tauri/src/commands.rs");
const releaseGuard = read(matrix.staging.guard);

expect(matrix.schemaVersion === 1, "schemaVersion must be 1");
expect(matrix.task === "21.2", "task must be 21.2");
expect(matrix.baseline.version === "0.7.4", "baseline must be 0.7.4");
expect(matrix.baseline.sha === "131df88753c812c0fdf440a5558fff46b2a83f57", "audited 0.7.4 SHA drifted");
expect(matrix.baseline.bundleIdentifier === "vtm.beatgaler.playground", "legacy bundle identifier drifted");
expect(releaseManifest.bundleIdentifier?.value === matrix.target.bundleIdentifier, "release manifest target bundle identifier diverged");
expect(tauri.identifier === matrix.target.bundleIdentifier, "Tauri target bundle identifier diverged");

expect(upgradeRust.includes('LEGACY_BUNDLE_IDENTIFIER: &str = "vtm.beatgaler.playground"'), "Rust migration lost the audited legacy bundle id");
expect(upgradeRust.includes("copy_missing_tree(&legacy_dir, data_dir"), "legacy app-data tree is no longer copied into the current identity");
expect(upgradeRust.includes("if target.exists()"), "destination non-overwrite guard disappeared");
expect(!upgradeRust.includes("remove_dir_all(&legacy_dir"), "rollback source can be destructively removed");
expect(upgradeRust.includes('for suffix in ["", "-wal", "-shm"]'), "SQLite recovery no longer preserves DB/WAL/SHM as a family");
expect(upgradeRust.includes('parent.join("recovery")'), "corrupt SQLite no longer has a recovery quarantine");

const migrateCall = rustLib.indexOf("upgrade::migrate_legacy_app_data(&data_dir)");
const dbOpen = rustLib.indexOf('let db_path = data_dir.join("beatvault.db")');
expect(migrateCall >= 0 && dbOpen > migrateCall, "legacy migration must run before SQLite is opened");
expect(rustLib.includes("upgrade::quarantine_sqlite_family(&db_path)"), "startup no longer recovers an unreadable SQLite file safely");

expect(rustCommands.includes('data_dir.join("settings.json")'), "settings are no longer rooted in app-data");
expect(rustCommands.includes('state.data_dir.join("offline")'), "offline packages are no longer rooted in app-data");
expect(rustCommands.includes('std::env::temp_dir().join("BeatGaler")'), "playback cache temp root changed; 0.7.4 cache continuity needs re-audit");
expect(rustCommands.includes('beatgaler_temp_dir().join("cloud-cache").join("audio")'), "playback cache path contract changed");

expect(matrix.staging.sameSourceShaRequired === true, "staging same-SHA requirement must remain enabled");
expect(releaseGuard.includes("RELEASE_SOURCE_SHA"), "release guard no longer checks the shared source SHA");
expect(releaseGuard.includes("git checkout --detach"), "release tooling is no longer pinned to the artifact source SHA");
expect(releaseGuard.includes("runtime provenance"), "release guard no longer validates runtime provenance");

console.log(`PASS upgrade matrix: ${matrix.baseline.version} (${matrix.baseline.sha.slice(0, 12)}) -> ${read(matrix.target.versionSource).trim()} preserves app-data/offline state, stable playback cache, recovery evidence, and same-SHA staging guards.`);
