import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const exists = rel => fs.existsSync(path.join(root, rel));
let passed = 0;

function ok(condition, message) {
  if (!condition) throw new Error(`Mac portability gate failed: ${message}`);
  passed += 1;
  console.log(`PASS ${message}`);
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = text.indexOf(end, startIndex + start.length);
  return endIndex < 0 ? text.slice(startIndex) : text.slice(startIndex, endIndex);
}

const commands = read("src-tauri/src/commands.rs");
const app = read("src/App.tsx");
const accountGate = read("src/components/AccountGate.tsx");
const settingsPanel = read("src/components/SettingsPanel.tsx");
const drawer = read("src/components/Drawer.tsx");
const addBeatModal = read("src/components/AddBeatModal.tsx");
const importAudioConflicts = read("src/components/ImportAudioConflictsModal.tsx");
const htmlDrop = read("src/features/dragdrop/htmlDropController.ts");
const helper = read("src-tauri/direct-transport/transport-helper.cjs");
const libRs = read("src-tauri/src/lib.rs");
const cargo = read("src-tauri/Cargo.toml");
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const tauriMac = JSON.parse(read("src-tauri/tauri.macos.conf.json"));
const macBuildWorkflow = read(".github/workflows/build-macos.yml");
const windowsBuildWorkflow = read(".github/workflows/build-windows.yml");
const desktopReleaseWorkflow = read(".github/workflows/release-desktop-updater.yml");
const updaterManifest = read("scripts/updater-manifest.mjs");
const player = read("src/components/Player.tsx");
const directControl = read("cloud-server/direct-transport-control.js");
const cloudServer = read("cloud-server/server.js");
const dialog = read("src/lib/dialog.ts");
const userVisibleError = read("src/lib/userVisibleError.ts");
const portabilityWorkflow = read(".github/workflows/test-desktop-portability.yml");
const packageJson = JSON.parse(read("package.json"));
const cargoLockTest = read("scripts/test-cargo-lock.mjs");
const runtimeDylibCheck = read("scripts/check-macos-runtime-dylibs.sh");

const projectZip = section(commands, "fn project_zip_entry_names", "fn project_manifest");
ok(!commands.includes("Manual PROJECT zip editing is currently implemented for Windows"), "PROJECT mutation has no Windows-only hard failure");
ok(projectZip.includes("zip::ZipArchive") && projectZip.includes("zip::ZipWriter"), "PROJECT ZIP read/write uses Rust zip implementation");
ok(!/powershell|Command::new\(\"zip\"\)|Command::new\(\"unzip\"\)/i.test(projectZip), "PROJECT ZIP mutation/filter has no PowerShell/zip/unzip shell dependency");
ok(commands.includes("rust_project_zip_mutation_replaces_primary_project_without_touching_assets"), "PROJECT ZIP has real mutation regression tests");
ok(commands.includes("rust_project_zip_mutation_supports_logicx_package_directories"), "Logic .logicx package mutation has a regression test");
ok(!commands.includes("Compress-Archive") && !commands.includes('Command::new("zip")') && !commands.includes('Command::new("unzip")'), "PROJECT creation has no OS shell ZIP implementation");
ok(commands.includes("prepare_project_edit_copy(&beat, &archive_path)") && commands.includes("repack_project_edit_copy_if_present(&beat, &zip_path)"), "Open Project extracts the DAW project and Update repacks edits into PROJECT.zip");
ok(commands.includes("project_open_edit_repack_cycle_is_cross_platform_for_logicx_and_special_paths"), "PROJECT open/edit/repack has a cross-platform Logic + special-path regression test");
ok(commands.includes("follow_links(false)") && commands.includes("entry.file_type().is_symlink()"), "PROJECT filesystem traversal does not follow symlinks");
ok(commands.includes("path_is_symbolic_link") && commands.includes("Symbolic links are not imported. Drop the original project file or folder instead."), "PROJECT top-level symlinks are rejected instead of following outside targets");
ok(commands.includes("if !root_path.exists() || path_is_symbolic_link(&root_path) { continue; }") && commands.includes("if entry.file_type().is_symlink() { return false; }"), "streaming import does not follow filesystem symlinks");

ok(app.includes("getCurrentWebview().onDragDropEvent"), "Tauri native filesystem drop listener is installed");
ok(app.includes("if (!isTauriAvailable) return;"), "native drop listener is not gated to Windows only");
ok(app.includes("claimNativeLibraryDrop()") && htmlDrop.includes("waitForNativeLibraryDropClaim"), "Mac duplicate native/HTML local drops are arbitrated");
ok(app.includes("if (isMacDesktop && artworkBeatId) return;"), "Mac native path leaves artwork/Pinterest on the proven HTML path");

ok(!helper.includes('|| "http://127.0.0.1:8081"') && !helper.includes("|| 'http://127.0.0.1:8081'"), "Direct helper has no fixed 8081 fallback");
ok(commands.includes("TcpListener::bind((\"127.0.0.1\", 0))"), "local data plane reserves a dynamic loopback port");
ok(commands.includes("LocalBotApiRuntime") && commands.includes("watchdog: Child"), "local data plane tracks owned child and watchdog");
ok(commands.includes("runtime-watchdog.cjs") && exists("src-tauri/direct-transport/runtime-watchdog.cjs"), "crash watchdog is bundled in source");
ok(!commands.includes("--http-port=8081"), "Rust local data plane does not hardcode port 8081");
ok(helper.includes("Direct transport session is incomplete"), "helper refuses sessions without explicit local Bot API base");
ok(!directControl.includes("127.0.0.1:8081") && !directControl.includes("CLIENT_LOCAL_BOT_API_BASE"), "Galer Cloud control plane does not dictate a Desktop loopback port");
ok(directControl.includes("DIRECT_TOKEN_ROTATION_ENABLED || 'false'") && directControl.includes("TOKEN_ROTATION_ENABLED"), "Direct token rotation remains disabled by default");
ok(commands.includes("classify_direct_begin_response") && commands.includes("DirectBeginDisposition::Expired") && commands.includes("continue;"), "first Direct operation can recover an expired sleep/wake lease");
ok(commands.includes("expired_operation_after_sleep_requests_session_recovery"), "sleep/wake lease recovery has a unit regression test");
ok(commands.includes("owned_local_bot_api_is_healthy()") && commands.includes("same_user_helper_alive && owned_local_bot_api_is_healthy()"), "Direct runtime health requires both the owned helper and owned local Bot API process");
ok(commands.includes("if !same_user {\n            direct_stop_server_session") && commands.includes("reconnecting_same_lease={}"), "same-user helper/Bot API crashes rebuild locally without releasing or rotating the server lease");
ok(commands.includes('join("diagnostics")') && commands.includes('"BOT_API_START"') && commands.includes('"BOT_API_READY"') && commands.includes('"BOT_API_EXIT"'), "local data-plane diagnostics persist lifecycle events without relying on /tmp only");
ok(commands.includes('"direct-bot-api-{}-{}"') && commands.includes("random_urlsafe(8)") && commands.includes("remove_dir_all(&runtime.work_dir)"), "each local data-plane process owns a unique runtime directory and cleans it on normal/recovered shutdown");

ok(cargo.includes('tauri-plugin-single-instance = "=2.4.3"'), "desktop uses the pinned Mac-safe single-instance plugin release");
ok(libRs.indexOf("tauri_plugin_single_instance::init") < libRs.indexOf("tauri_plugin_wdio::init"), "single-instance plugin is registered first");

ok(accountGate.includes("cloudApiBase: getResolvedCloudApiBase()"), "React passes the resolved Galer Cloud base to Rust auth context");
ok(commands.includes("cloud_api_base: Option<String>") && commands.includes("cloud_api_base_slot"), "Rust Direct uses the frontend-selected Galer Cloud origin");

const artworkSync = section(app, "const handleDropArtwork", "const runBeatCloudUpdate");
ok(artworkSync.includes('updated.telegram_file_id && connectionState === "online"'), "explicit artwork changes always attempt cloud sync when online");
ok(!artworkSync.includes('connectionState === "online" && cloudSessionVerified'), "artwork sync is not silently gated by transient cloudSessionVerified");

const offline = section(commands, "pub fn make_beat_available_offline", "pub fn remove_beat_offline_availability");
ok(offline.includes("let mut current = beat.clone();"), "Make Offline uses live Beat metadata as authority");
ok(!offline.includes("let mut current = existing_beat_meta(&conn, &beat.id).unwrap_or_else"), "Make Offline does not replace live metadata with stale SQLite snapshot");

ok(tauri.bundle?.macOS?.minimumSystemVersion === "12.0", "macOS minimum system version is explicit (12.0)");
ok(tauri.bundle?.macOS?.hardenedRuntime === true, "macOS hardened runtime is explicit");
ok(tauriMac.bundle?.resources?.["resources/telegram-bot-api"] === "telegram-bot-api", "macOS bundle includes local Bot API runtime");
ok(tauriMac.bundle?.resources?.["direct-transport/runtime-watchdog.cjs"] === "direct-transport/runtime-watchdog.cjs", "macOS bundle includes crash watchdog");

ok(!exists(".github/workflows/build-macos-fast.yml") && !exists(".github/workflows/build-macos-cloud-beta.yml") && !exists(".github/workflows/release-windows-updater.yml") && !exists(".github/workflows/test-macos-portability.yml"), "obsolete split/legacy Desktop workflows are removed");
ok(macBuildWorkflow.includes("name: Build - macOS") && windowsBuildWorkflow.includes("name: Build - Windows") && desktopReleaseWorkflow.includes("name: Release - Desktop Updater") && portabilityWorkflow.includes("name: Test - Desktop Portability"), "Desktop CI uses the canonical four-workflow layout");
const pinnedCommit = "adfd7f6a8e990272851777eeb3ae0def4216f161";
ok(macBuildWorkflow.includes(pinnedCommit), "Bot API source is pinned to an exact commit in the canonical Mac build");
ok(macBuildWorkflow.includes('MACOSX_DEPLOYMENT_TARGET: "12.0"'), "Mac build has an explicit deployment target");
ok(exists("scripts/check-macos-min-version.mjs") && exists("scripts/test-macos-min-version.mjs"), "Mach-O minimum-version checker has a portable parser regression test");
ok(macBuildWorkflow.includes("check-macos-min-version.mjs"), "canonical Mac build rejects runtimes requiring a newer macOS than supported");
ok(macBuildWorkflow.includes("macos-15-intel") && macBuildWorkflow.includes("macos-15"), "Universal Mac build creates native Bot API halves on Intel and ARM runners");
ok(macBuildWorkflow.includes("lipo -create") && macBuildWorkflow.includes("telegram-bot-api"), "Universal Mac build combines Bot API ARM64+x86_64 with lipo");
ok(macBuildWorkflow.includes("APP_MAIN_PATH") && macBuildWorkflow.includes("BOT_API_PATH") && macBuildWorkflow.includes("NODE_PATH") && macBuildWorkflow.includes("FFMPEG_PATH"), "final DMG verifies app + Node + FFmpeg + Bot API architectures");
ok(macBuildWorkflow.includes('APPLE_SIGNING_IDENTITY: "-"'), "canonical Mac build uses ad-hoc signing without Apple Developer ID");
ok(!macBuildWorkflow.includes("xcrun stapler validate") && macBuildWorkflow.includes("codesign --verify"), "Mac build verifies ad-hoc signing output without requiring notarization");
ok(macBuildWorkflow.includes("Ad-hoc sign embedded Universal Mach-O runtimes") && macBuildWorkflow.includes("codesign --force --sign -"), "Mac build ad-hoc signs every embedded executable before bundling");
ok(!macBuildWorkflow.includes("Authority=Developer ID Application:"), "ad-hoc Mac build does not require Developer ID authority");
ok(macBuildWorkflow.includes(".app.tar.gz") && macBuildWorkflow.includes(".app.tar.gz.sig") && macBuildWorkflow.includes("BeatGaler-macOS-Universal"), "Mac build exports a signed updater-ready artifact without publishing it");
ok(macBuildWorkflow.includes("BEATGALER_UPDATER_ENDPOINT: https://github.com/magosouljah/galer/releases/latest/download/latest.json"), "Mac build compiles the real HTTPS updater endpoint into the app");
ok(!macBuildWorkflow.includes("gh release create") && !macBuildWorkflow.includes("gh release upload") && !macBuildWorkflow.includes("PUBLIC_RELEASE_TOKEN"), "Mac build does not publish a public GitHub release");
ok(windowsBuildWorkflow.includes("TAURI_SIGNING_PRIVATE_KEY") && windowsBuildWorkflow.includes("--bundles nsis") && windowsBuildWorkflow.includes("*.exe.sig") && windowsBuildWorkflow.includes("BeatGaler-Windows-x64"), "Windows build exports a signed updater-ready NSIS artifact");
ok(!windowsBuildWorkflow.includes("gh release create") && !windowsBuildWorkflow.includes("gh release upload") && !windowsBuildWorkflow.includes("PUBLIC_RELEASE_TOKEN"), "Windows build does not publish a public GitHub release");
ok(updaterManifest.includes("baseManifest") && updaterManifest.includes("--merge-existing"), "updater manifest can merge Windows and Mac platforms without deleting either");
ok(exists("scripts/test-updater-manifest.mjs"), "updater Windows/Mac manifest merge has a portable regression test");
ok(cargo.includes('zip = { version = "=4.6.1"') && cargo.includes('unicode-normalization = "=0.1.25"'), "new cross-platform Rust dependencies are pinned to exact direct versions");
ok(cargo.includes('tauri-plugin-single-instance = "=2.4.3"'), "single-instance dependency is also pinned exactly");
ok(packageJson.scripts?.["test:mac-portability"]?.includes("npm run test:cargo-lock") && packageJson.scripts?.["test:mac-portability:locked"]?.includes("cargo test --locked"), "Mac portability commands validate Cargo.lock and expose a locked CI mode");
ok(cargoLockTest.includes('"zip", "4.6.1"') && cargoLockTest.includes('"unicode-normalization", "0.1.25"') && cargoLockTest.includes('"tauri-plugin-single-instance", "2.4.3"'), "Cargo.lock regression validates every newly pinned portability dependency");
ok(portabilityWorkflow.includes("git diff --exit-code -- src-tauri/Cargo.lock") && portabilityWorkflow.includes("regenerated-Cargo-lock"), "Windows CI fails closed on an uncommitted regenerated Cargo.lock and preserves it as an artifact");
ok(portabilityWorkflow.includes("npm run test:mac-portability:locked"), "hosted native Mac CI compiles only the committed Cargo.lock graph");
ok(macBuildWorkflow.includes("cargo test --locked --manifest-path src-tauri/Cargo.toml --lib"), "Mac build refuses dependency resolution drift");
ok(macBuildWorkflow.includes("cargo metadata --locked") && windowsBuildWorkflow.includes("cargo metadata --locked"), "Desktop build workflows preflight the committed Rust dependency graph");
ok(exists("scripts/check-macos-runtime-dylibs.sh") && runtimeDylibCheck.includes('/usr/lib/*|/System/Library/*'), "embedded runtime dylib audit permits only Apple system dependencies");
ok((macBuildWorkflow.match(/check-macos-runtime-dylibs\.sh/g) || []).length >= 2, "Universal Mac build audits FFmpeg, Node, and Bot API both before bundling and inside the DMG");

ok(desktopReleaseWorkflow.includes('group: release-desktop-${{ inputs.release_tag }}'), "Desktop release serializes publication per release tag");
ok(desktopReleaseWorkflow.includes("windows_run_id") && desktopReleaseWorkflow.includes("macos_run_id") && desktopReleaseWorkflow.includes("head_sha"), "Desktop release selects explicit Windows/macOS runs and verifies a shared source commit");
ok(desktopReleaseWorkflow.includes("Download Windows build") && desktopReleaseWorkflow.includes("Download macOS build"), "Desktop release consumes prebuilt artifacts instead of rebuilding applications");
ok(!desktopReleaseWorkflow.includes("npx tauri build") && !desktopReleaseWorkflow.includes("cargo build"), "Desktop release workflow does not compile Desktop binaries");
ok(desktopReleaseWorkflow.includes("windows-x86_64") && desktopReleaseWorkflow.includes("darwin-aarch64") && desktopReleaseWorkflow.includes("darwin-x86_64") && desktopReleaseWorkflow.includes("--merge-existing"), "Desktop release emits one updater manifest for Windows, Apple Silicon, and Intel Mac");
ok(desktopReleaseWorkflow.includes("gh release create") && desktopReleaseWorkflow.includes("gh release upload") && desktopReleaseWorkflow.includes("PUBLIC_RELEASE_TOKEN"), "Desktop release is the sole public GitHub publication owner");
ok(libRs.includes("WindowEvent::CloseRequested") && libRs.includes("api.prevent_close()") && libRs.includes("window.hide()"), "macOS red close hides instead of destroying the main window");
ok(libRs.includes("RunEvent::Reopen") && libRs.includes('get_webview_window("main")'), "macOS Dock reopen restores the hidden main window");
ok(cargo.includes('unicode-normalization = "=0.1.25"') && commands.includes(".nfc()"), "beat identity normalizes Unicode to NFC across Windows/macOS");
ok(commands.includes("canonical_unicode_forms_share_one_beat_identity"), "Unicode NFC/NFD identity has a regression test");
ok(!commands.includes('Command::new("ffmpeg")') && (commands.match(/beatgaler_ffmpeg_program\(\)\?/g) || []).length >= 3, "YouTube and WAV conversion use BeatGaler's bundled FFmpeg instead of assuming a system install");

ok(!app.includes("Windows reported a file drop"), "user-facing drag error is platform-neutral");
ok(!htmlDrop.includes("WebView2 exposed no usable image payload"), "user-facing browser artwork error is platform-neutral");
ok(player.includes("Reveal in Finder"), "Mac UI has Finder-specific reveal wording");

const publicServerErrorTexts = cloudServer.split(/\r?\n/).filter(line => line.includes("error:")).map(line => line.slice(line.indexOf("error:") + 6));
ok(!publicServerErrorTexts.some(text => /telegram|bot api|transport bot|001beatgaler|tdlib/i.test(text)), "public Cloud HTTP errors do not expose the hidden storage implementation");
ok(!cloudServer.split(/\r?\n/).some(line => line.includes("res.status(500).json") && line.includes("err.message")), "public Cloud HTTP 500 responses do not forward raw internal exception text");
ok(dialog.includes("sanitizeUserVisibleText(normalized.message") && userVisibleError.includes("[redacted credential]"), "application alerts sanitize hidden transport names and credential-looking text before rendering");
ok((app.match(/sanitizeUserVisibleText\(runtimeErrorMessage/g) || []).length >= 8, "runtime-state/cloud inline errors are sanitized before being stored for rendering");
ok(settingsPanel.includes("sanitizeUserVisibleText(updateMessage") && settingsPanel.includes("Update operation failed."), "updater messages pass through the final user-visible privacy boundary");
ok(drawer.includes("sanitizeUserVisibleText(error)") && drawer.includes("sanitizeUserVisibleText(cloudError)"), "Drawer renders native/cloud errors through the privacy boundary");
ok(addBeatModal.includes("sanitizeUserVisibleText(error)"), "Add Beat renders native import errors through the privacy boundary");
ok(importAudioConflicts.includes("sanitizeUserVisibleText(error)"), "import conflict resolution renders native errors through the privacy boundary");
const rustLiteralErrorTexts = commands.split(/\r?\n/).filter(line => /return Err\(|ok_or\(|ok_or_else|last_error\s*=/.test(line)).flatMap(line => [...line.matchAll(/"([^"]*)"/g)].map(match => match[1]));
ok(!rustLiteralErrorTexts.some(text => /telegram|bot api|transport bot|001beatgaler|tdlib/i.test(text)), "Rust user-facing literal errors do not expose hidden storage implementation names");
ok(macBuildWorkflow.indexOf("Combine pinned Bot API into Universal runtime") < macBuildWorkflow.indexOf("cargo test --locked --manifest-path src-tauri/Cargo.toml --lib"), "Universal Mac Rust gate compiles only after required bundle resources exist");
ok(portabilityWorkflow.includes("Prepare compile-only Mac resource placeholders") && portabilityWorkflow.indexOf("Prepare compile-only Mac resource placeholders") < portabilityWorkflow.indexOf("npm run test:mac-portability:locked", portabilityWorkflow.indexOf("macos-native-smoke")), "hosted macOS portability CI creates compile-only resource placeholders before locked Cargo tests");

console.log(`PASS Mac portability static gate (${passed} invariants)`);
