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
const windowsRelease = json(matrix.windowsInstaller.releaseConfig);
const nsisHooks = read(matrix.windowsInstaller.hooks);
const upgradeRust = read("src-tauri/src/upgrade.rs");
const rustLib = read("src-tauri/src/lib.rs");
const rustCommands = read("src-tauri/src/commands.rs");
const releaseGuard = read(matrix.staging.guard);

expect(matrix.schemaVersion === 1, "schemaVersion must be 1");
expect(matrix.task === "21.2", "task must be 21.2");
expect(matrix.baseline.version === "0.7.4", "baseline must be 0.7.4");
expect(matrix.baseline.sha === "131df88753c812c0fdf440a5558fff46b2a83f57", "audited 0.7.4 SHA drifted");
expect(matrix.baseline.productName === "Beat Galer", "legacy product name drifted");
expect(matrix.baseline.bundleIdentifier === "vtm.beatgaler.playground", "legacy bundle identifier drifted");
expect(matrix.target.productName === "Galer", "target product name drifted");
expect(releaseManifest.productName === matrix.target.productName, "release manifest product name diverged");
expect(releaseManifest.bundleIdentifier?.value === matrix.target.bundleIdentifier, "release manifest target bundle identifier diverged");
expect(tauri.productName === matrix.target.productName, "Tauri target product name diverged");
expect(tauri.identifier === matrix.target.bundleIdentifier, "Tauri target bundle identifier diverged");

expect(upgradeRust.includes('LEGACY_BUNDLE_IDENTIFIER: &str = "vtm.beatgaler.playground"'), "Rust migration lost the audited legacy bundle id");
expect(upgradeRust.includes("copy_missing_tree(&legacy_dir, data_dir"), "legacy app-data tree is no longer copied into the current identity");
expect(upgradeRust.includes("if target.exists()"), "destination non-overwrite guard disappeared");
expect(!upgradeRust.includes("remove_dir_all(&legacy_dir"), "rollback source can be destructively removed");
expect(upgradeRust.includes('for suffix in ["", "-wal", "-shm"]'), "SQLite recovery no longer preserves DB/WAL/SHM as a family");
expect(upgradeRust.includes('parent.join("recovery")'), "corrupt SQLite no longer has a recovery quarantine");
expect(upgradeRust.includes("real_sqlite_rows_survive_074_identity_migration"), "real SQLite preservation regression test disappeared");

const migrateCall = rustLib.indexOf("upgrade::migrate_legacy_app_data(&data_dir)");
const dbOpen = rustLib.indexOf('let db_path = data_dir.join("beatvault.db")');
expect(migrateCall >= 0 && dbOpen > migrateCall, "legacy migration must run before SQLite is opened");
expect(rustLib.includes("upgrade::quarantine_sqlite_family(&db_path)"), "startup no longer recovers an unreadable SQLite file safely");

expect(rustCommands.includes('data_dir.join("settings.json")'), "settings are no longer rooted in app-data");
expect(rustCommands.includes('state.data_dir.join("offline")'), "offline packages are no longer rooted in app-data");
expect(rustCommands.includes('std::env::temp_dir().join("BeatGaler")'), "playback cache temp root changed; 0.7.4 cache continuity needs re-audit");
expect(rustCommands.includes('beatgaler_temp_dir().join("cloud-cache").join("audio")'), "playback cache path contract changed");

expect(matrix.windowsInstaller.reuseLegacyInstallLocation === true, "Windows legacy install location reuse must stay enabled");
expect(matrix.windowsInstaller.retireLegacyRegistrationAfterInstall === true, "Windows legacy registration cleanup must happen only after install");
expect(windowsRelease.bundle?.windows?.nsis?.installerHooks === "./windows/upgrade-hooks.nsh", "Windows release config no longer enables the 0.7.4 NSIS bridge");
expect(nsisHooks.includes('GALER_LEGACY_PRODUCTNAME "Beat Galer"'), "NSIS bridge lost legacy product name");
expect(nsisHooks.includes('GALER_LEGACY_UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Beat Galer"'), "NSIS bridge lost legacy uninstall key");
expect(nsisHooks.includes("StrCpy $INSTDIR $R8"), "NSIS bridge no longer reuses the managed 0.7.4 install location");
const newRegistrationComment = nsisHooks.indexOf("new Galer registration/uninstaller has already been written");
const deleteLegacyRegistration = nsisHooks.indexOf('DeleteRegKey SHCTX "${GALER_LEGACY_UNINSTKEY}"');
expect(newRegistrationComment >= 0 && deleteLegacyRegistration > newRegistrationComment, "legacy NSIS registration can be removed before the new install is durable");
expect(nsisHooks.includes('CreateShortcut "$SMPROGRAMS\\${PRODUCTNAME}.lnk"'), "start-menu shortcut rename continuity disappeared");
expect(nsisHooks.includes('CreateShortcut "$DESKTOP\\${PRODUCTNAME}.lnk"'), "desktop shortcut choice continuity disappeared");

expect(matrix.staging.sameSourceShaRequired === true, "staging same-SHA requirement must remain enabled");
expect(releaseGuard.includes("RELEASE_SOURCE_SHA"), "release guard no longer checks the shared source SHA");
expect(releaseGuard.includes("git checkout --detach"), "release tooling is no longer pinned to the artifact source SHA");
expect(releaseGuard.includes("runtime provenance"), "release guard no longer validates runtime provenance");

console.log(`PASS upgrade matrix: ${matrix.baseline.version} (${matrix.baseline.sha.slice(0, 12)}) -> ${read(matrix.target.versionSource).trim()} preserves app-data/SQLite/offline/cache, bridges the renamed Windows installer in-place, preserves recovery evidence, and keeps same-SHA staging guards.`);
