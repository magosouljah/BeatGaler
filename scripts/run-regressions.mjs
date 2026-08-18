import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, ".regression-build");
const localTsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

function fail(message) {
  console.error(`FAIL regression guard: ${message}`);
  process.exit(1);
}

rmSync(buildDir, { recursive: true, force: true });
try {
  const tscArgs = ["-p", path.join(root, "scripts", "tsconfig.regressions.json")];
  if (existsSync(localTsc)) {
    execFileSync(process.execPath, [localTsc, ...tscArgs], { cwd: root, stdio: "inherit" });
  } else {
    const command = process.platform === "win32" ? "tsc.cmd" : "tsc";
    try {
      execFileSync(command, tscArgs, { cwd: root, stdio: "inherit" });
    } catch {
      fail("TypeScript is not installed. Run npm install/npm ci first.");
    }
  }
  execFileSync(process.execPath, [path.join(buildDir, "scripts", "regression-dragdrop.js")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(root, "scripts", "regression-import-native.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(root, "scripts", "regression-phase9cd.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(buildDir, "scripts", "regression-playback-readiness.js")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(buildDir, "scripts", "regression-beat-runtime-state.js")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(root, "scripts", "regression-telegram-retry.cjs")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(root, "scripts", "regression-direct-manager-only.mjs")], {
    cwd: root,
    stdio: "inherit",
  });

  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const beatCard = readFileSync(path.join(root, "src", "components", "BeatCard.tsx"), "utf8");
  const controller = readFileSync(path.join(root, "src", "features", "dragdrop", "htmlDropController.ts"), "utf8");
  const rustLib = readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
  const nativeExternalImage = readFileSync(path.join(root, "src", "features", "dragdrop", "nativeExternalImage.ts"), "utf8");
  const wryPatch = readFileSync(path.join(root, "scripts", "wry-patches", "wry-0.54.2-drag_drop.rs"), "utf8");
  const wryPatchInstaller = readFileSync(path.join(root, "scripts", "patch-wry-pinterest.mjs"), "utf8");
  const runTauriScript = readFileSync(path.join(root, "scripts", "run-tauri.ps1"), "utf8");
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const audioHook = readFileSync(path.join(root, "src", "hooks", "useAudio.ts"), "utf8");
  if (!audioHook.includes('beatgaler:audio-playing') || !app.includes('window.addEventListener("beatgaler:audio-playing"')) fail("Playback runtime no longer waits for the real HTMLAudioElement playing event.");
  if (app.includes('transitionRuntime(beat.id, { type: "PLAYBACK_PLAYING" }, beat);') || app.includes('transitionRuntime(beat.id, { type: "PLAYBACK_PLAYING" }, ready);')) fail("Playback state is marked playing before audio actually starts.");

  const tauriConfig = readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8");
  if (!tauriConfig.includes('"dragDropEnabled": true')) fail("Windows native filesystem drag/drop is not enabled in Tauri config.");
  if (!app.includes("getCurrentWebview().onDragDropEvent")) fail("Windows Explorer drops are no longer using Tauri's native filesystem-path event.");
  if (!app.includes("TAURI_NATIVE_DROP") || !app.includes("WINDOWS_NATIVE_LIBRARY_IMPORT_START")) fail("Native Explorer drop diagnostics disappeared.");
  if (!app.includes("MAX_NATIVE_DROP_ITEMS = 50")) fail("Native Explorer drop safety cap disappeared.");
  if (!app.includes("windowsNativeDrop") || !app.includes("if (windowsNativeDrop) return")) fail("HTML DataTransfer staging is still installed on Windows and can race native filesystem drops.");
  if (app.includes('listen<NativeDragPayload>("beatgaler-native-drag"')) fail("Obsolete custom OLE event router returned.");
  if (rustLib.includes('mod native_drop;') || rustLib.includes("native_drop::install(app)")) fail("Obsolete custom OLE HWND router is still installed.");
  if (!rustLib.includes("Tauri native filesystem drop enabled")) fail("Rust startup no longer identifies the official native file-drop path.");
  if (!app.includes("readImagePathAsDataUrl")) fail("Native Explorer artwork path support disappeared.");
  if (app.includes('document.addEventListener("drop"')) fail("App.tsx owns a raw document drop listener; the HTML fallback belongs in htmlDropController.ts.");
  if (beatCard.includes("onDropArtwork")) fail("BeatCard reintroduced its own artwork drop pipeline.");
  if (!controller.includes('document.addEventListener("drop"')) fail("htmlDropController.ts lost the non-Windows/browser fallback.");
  if (!controller.includes("captureArtworkSourcesFromDataTransfer(dt)")) fail("HTML fallback lost browser artwork capture.");

  // Pinterest Option-2 regression shield. WRY remains the ONE Windows OLE
  // IDropTarget. Real CF_HDROP files/folders short-circuit before any browser
  // format query; only non-CF_HDROP payloads can inspect HTML/URL/text on Drop.
  if (!wryPatch.includes("BEATGALER_OPTION2_PATCH_V2")) fail("Pinned WRY 0.54.2 Pinterest patch marker disappeared.");
  if (!wryPatch.includes("CF_HDROP local fast path remains") && !wryPatch.includes("Critical BeatGaler performance invariant")) fail("WRY patch lost the documented CF_HDROP-first performance invariant.");
  if (!wryPatch.includes("let is_external = if hdrop.is_some() {\n      false\n    } else {")) fail("Local CF_HDROP drops can probe browser formats again.");
  if (!wryPatch.includes("Chromium Web Custom MIME Data Format")) fail("Native Pinterest bridge lost Chromium custom MIME container support.");
  if (!wryPatch.includes("format.tymed = 1 | 2 | 4")) fail("Native Pinterest DragEnter probe is HGLOBAL-only again and can reject browser drags before Drop.");
  const wryDragOverStart = wryPatch.indexOf("  fn DragOver(");
  const wryDragLeaveStart = wryPatch.indexOf("  fn DragLeave(", wryDragOverStart);
  const wryDragOverBlock = wryPatch.slice(wryDragOverStart, wryDragLeaveStart);
  if (wryDragOverBlock.includes("read_external_drop_payload") || wryDragOverBlock.includes("inspect_external_drop") || wryDragOverBlock.includes("GetData(")) fail("Pinterest bytes are being read during DragOver.");
  const wryDropStart = wryPatch.indexOf("  fn Drop(");
  if (wryDropStart < 0 || !wryPatch.slice(wryDropStart).includes("inspect_external_drop(data_obj)")) fail("External HTML/URL/text is no longer inspected on native Drop.");
  if (!wryPatch.includes("[native-drop-data] FORMAT CF_HDROP=false") || !wryPatch.includes("[native-drop-data] INSPECT_US=")) fail("Native Pinterest format/performance diagnostics disappeared.");
  if (!wryPatch.includes("MAX_EXTERNAL_TEXT_BYTES")) fail("Native browser payload inspection lost its bounded byte cap.");
  if (!wryPatch.includes("i.pinimg.com") || !wryPatch.includes("HTML Format") || !wryPatch.includes("UniformResourceLocatorW") || !wryPatch.includes("application/x-pinterest-closeup-image")) fail("Native Pinterest extraction lost required URL/HTML/custom-format coverage.");

  if (!nativeExternalImage.includes("__BEATGALER_EXTERNAL_IMAGE_V1__")) fail("Native external-image bridge prefix disappeared.");
  if (!app.includes('window.dispatchEvent(new CustomEvent("native-external-image-drop"')) fail("WRY external-image payload is no longer emitted as a separate BeatGaler artwork event.");
  if (!app.includes('window.addEventListener("native-external-image-drop"')) fail("BeatGaler no longer receives the native external-image artwork event.");
  if (!app.includes("nativeExternalImageSignalFromPaths(incomingPaths)")) fail("Reserved external-image markers are no longer filtered at the Tauri event boundary.");
  if (!app.includes("URLs never enter Import Beat and are accepted only by an artwork target")) fail("Pinterest artwork-only routing invariant disappeared.");
  const nativeDropEffectStart = app.indexOf('if (!isTauriAvailable || !/Windows/i.test(navigator.userAgent)) return;', app.indexOf("Non-Windows/browser fallback only."));
  const nativeDropEffectEnd = app.indexOf("  const handleCloudFiles =", nativeDropEffectStart);
  const nativeDropEffect = app.slice(nativeDropEffectStart, nativeDropEffectEnd);
  const nativeDropCodeOnly = nativeDropEffect
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  if (nativeDropCodeOnly.includes("stageCapturedHtmlDrop")) fail("Windows native local drop routes into stageCapturedHtmlDrop again.");
  if (nativeDropCodeOnly.includes(".arrayBuffer(")) fail("Windows native local drop reads full file bytes with arrayBuffer().");
  const bridgeFilterIndex = nativeDropEffect.indexOf("nativeExternalImageSignalFromPaths(incomingPaths)");
  const localDropDispatchIndex = nativeDropEffect.indexOf("void handleNativeDrop({ paths: incomingPaths", bridgeFilterIndex);
  if (bridgeFilterIndex < 0 || localDropDispatchIndex < 0 || bridgeFilterIndex > localDropDispatchIndex) fail("External-image sentinel is not filtered before the local filesystem drop router.");

  if (!wryPatchInstaller.includes('const WRY_VERSION = "0.54.2"') || !wryPatchInstaller.includes("ec03770d82dbbf47cbc3932a1b709bd8aed5a0914e20b6afdcc6629fed99c7ee")) fail("WRY patch installer is no longer pinned to the verified upstream 0.54.2 source.");
  if (!wryPatchInstaller.includes("Refusing to overwrite unexpected WRY")) fail("WRY patch installer can overwrite an unknown Cargo registry source.");
  if (!runTauriScript.includes("patch-wry-pinterest.mjs")) fail("npm run tauri can start without activating the pinned WRY Option-2 patch.");
  if (!String(packageJson.scripts?.build ?? "").startsWith("node scripts/patch-wry-pinterest.mjs &&")) fail("npm run build no longer primes the WRY patch before the required cargo check sequence.");
  if (rustLib.includes("native_drop::install") || rustLib.includes("mod native_drop;")) fail("A second custom Windows IDropTarget was activated; WRY must remain the sole owner.");

  console.log("PASS architecture guard: WRY remains the single Windows drop owner; CF_HDROP stays zero-copy and Pinterest HTML/URL/text is isolated to artwork-only native Drop");

  // Cursor regression shield. Range/checkbox/radio controls must never inherit
  // the text I-beam just because they are <input> elements. Only text-editing
  // controls are allowed to opt into cursor:text.
  if (app.includes('input, textarea, [contenteditable="true"]')) fail("Global custom-cursor CSS reintroduced cursor:text for every input; range sliders would show an I-beam again.");
  if (!app.includes('input[type="text"]') || !app.includes('input[type="email"]') || !app.includes('[contenteditable="true"]')) fail("Custom-cursor CSS lost the explicit text-editing input whitelist.");
  if (!app.includes('input[type="range"]') && !readFileSync(path.join(root, "src", "components", "Player.tsx"), "utf8").includes('type="range"')) fail("Volume range control could not be located for cursor regression coverage.");
  console.log("PASS cursor guard: range controls keep the normal BeatGaler cursor instead of the text I-beam");

  // Existing-beat file-drop regression shield. Project files/ZIPs have one
  // destination and must bypass the role chooser; folders keep their original
  // name inside PROJECT.zip; long Telegram/ZIP work belongs to the beat card,
  // where Play is blocked and the normal green-success animation/sound is used.
  const tauriClient = readFileSync(path.join(root, "src", "lib", "tauri.ts"), "utf8");
  const rustProjectCommands = readFileSync(path.join(root, "src-tauri", "src", "commands.rs"), "utf8");
  const uploadBeatStart = rustProjectCommands.indexOf('pub fn upload_beat_to_telegram(');
  const uploadBeatEnd = rustProjectCommands.indexOf('#[tauri::command', uploadBeatStart + 1);
  const uploadBeatBlock = uploadBeatEnd > uploadBeatStart ? rustProjectCommands.slice(uploadBeatStart, uploadBeatEnd) : rustProjectCommands.slice(uploadBeatStart, uploadBeatStart + 9000);
  if (uploadBeatBlock.includes('local_library_has_duplicate_name')) fail("Cloud upload reintroduced stale SQLite duplicate-name authority; Telegram must own cloud name uniqueness.");
  if (!uploadBeatBlock.includes('final_cloud_display_name_after_review')) fail("Cloud upload lost the Telegram-authoritative duplicate-name gate.");
  if (app.includes('projectSamples') || app.includes('projectAudio') || app.includes('role: "other"')) fail("Existing-beat drop chooser reintroduced Samples/Audio split or Other.");
  if (!app.includes('Loop · Coming soon') || !app.includes('Stems · Coming soon')) fail("Loop/Stems must remain visible as Coming soon, not active upload destinations.");
  if (!app.includes('inspectProjectDropSource(filePath)')) fail("Project files/ZIPs lost automatic destination inspection.");
  if (!app.includes('const autoResult = await handleAutoProjectDrop(beat, root.path)')) fail("Recognized project files/ZIPs must bypass the redundant role chooser.");
  if (!controller.includes('onBeatFileStagingChange?.(beatId, true)') || !app.includes('onBeatFileStagingChange: (beatId, active)')) fail("Beat-card loading must begin before WebView2 copies/inspects a large PROJECT ZIP.");
  if (!app.includes('Replace PROJECT ZIP?') || !app.includes('Replace project file?')) fail("Existing PROJECT replacement lost its explicit Replace/Cancel confirmation.");
  if (!app.includes('setBeatFileDrop(null);') || !app.includes('const runBeatCloudUpdate')) fail("Long beat updates must close the chooser before background work starts.");
  if (!app.includes('beatCloudUpdateBusyIds.has(beat.id)')) fail("Queue/direct Play can bypass a running slot/project update.");
  if (!app.includes('setBeatCloudUpdateBusy(beat.id, false, true)')) fail("Successful existing-beat updates lost the success-phase event.");
  if (!beatCard.includes('slotUpdateComplete') || !beatCard.includes('detail.success')) fail("BeatCard lost the green completion animation for existing-beat updates.");
  if (!tauriClient.includes('inspect_project_drop_source') || !tauriClient.includes('"projectFile" | "projectFolder"')) fail("Tauri client lost smart PROJECT drop inspection/update kinds.");
  if (!rustLib.includes('inspect_project_drop_source')) fail("Tauri invoke handler lost PROJECT drop inspection.");
  if (!rustProjectCommands.includes('"flp" | "als" | "logicx" | "ptx" | "ptf"')) fail("PROJECT recognition must include FL Studio, Ableton, Logic Pro, and Pro Tools.");
  if (!rustProjectCommands.includes("A PROJECT ZIP needs at least one .flp, .als, .logicx, .ptx, or .ptf")) fail("PROJECT ZIP validation no longer requires a real project file.");
  if (!rustProjectCommands.includes('Command::new("tar")') || !rustProjectCommands.includes('project_zip_entry_names')) fail("PROJECT ZIP inspection lost the fast directory-list path/fallback architecture.");
  if (rustProjectCommands.includes("elseif ($rootName -eq 'audio'") || rustProjectCommands.includes('matches!(root.as_str(), "audio" | "sample" | "samples")')) fail("Audio/Samples-only ZIPs became valid PROJECT archives again.");
  if (!rustProjectCommands.includes("$Kind -eq 'projectfolder'") || !rustProjectCommands.includes('$prefix = "$folderName/"')) fail("Generic project folders must preserve their original folder name inside PROJECT.zip.");
  if (!rustProjectCommands.includes("#[tauri::command(async)]\npub fn update_project_archive_from_source")) fail("PROJECT archive mutation must run as an async Tauri command so the UI remains usable during large ZIP work.");
  if (!rustProjectCommands.includes("Test-ForbiddenPart")) fail("PROJECT ZIP mutation lost Backup/Backups filtering.");
  if (!app.includes('Backup folders were found in') || !app.includes('Backup folders were skipped from') || !tauriClient.includes('has_backups: boolean')) fail("Nested Backup/Backups filtering must be surfaced before and after project updates.");
  if (!rustProjectCommands.includes('filtered_project_zip_for_upload') || !rustProjectCommands.includes('if !has_backups { return Ok(None); }')) fail("PROJECT ZIPs with Backup/Backups must continue through a filtered temporary upload copy instead of being rejected.");
  if (rustProjectCommands.includes('Remove that backup folder from the ZIP and try again.')) fail("PROJECT ZIPs with Backup/Backups must not be rejected; BeatGaler should skip those folders.");
  console.log("PASS project-drop guard: beat target survives WebView2 drop, ZIP inspection shows loading, valid project types auto-route, and Backup folders are skipped (including inside ZIPs) with notice");

  // Export metadata regression shield. Cloud downloads must preserve source
  // metadata instead of rebuilding WAV tags from scratch, while the default
  // MP3/WAV filename carries the current [BPM Key] suffix.
  const rustCommandsForExport = readFileSync(path.join(root, "src-tauri", "src", "commands.rs"), "utf8");
  if (!app.includes("const audioSafeBase = exportMeta")) fail("Download dialog lost the [BPM Key] audio filename builder.");
  if (!app.includes('chooseExportFilePath(`${audioSafeBase}.mp3`')) fail("MP3 download default filename lost BPM/key metadata.");
  if (!app.includes('chooseExportFilePath(`${audioSafeBase}.wav`')) fail("WAV download default filename lost BPM/key metadata.");
  if (!rustCommandsForExport.includes("Metadata export is an OVERLAY, never a destructive rebuild")) fail("Audio export stopped preserving unrelated source ID3 metadata.");
  if (!rustCommandsForExport.includes("fn merge_existing_genre")) fail("Audio export lost source + BeatGaler genre/tag merging.");
  if (!rustCommandsForExport.includes("build_wav_list_info_chunk_preserving")) fail("WAV export lost RIFF INFO preservation.");
  if (!rustCommandsForExport.includes("INCLUDING ID3, bext, iXML")) fail("WAV export no longer documents/preserves non-INFO RIFF metadata chunks.");
  if (!rustCommandsForExport.includes('format!("{}.mp3", audio_safe_base)') || !rustCommandsForExport.includes('format!("{}.wav", audio_safe_base)')) fail("Everything export lost [BPM Key] MP3/WAV filenames.");
  console.log("PASS export metadata guard: source tags/chunks survive overlay and MP3/WAV filenames include BPM + key");

  // Remove/Trash regression shield. An empty active library is a valid state and
  // must never trigger an automatic pull of the OLD Telegram index. Trash labels
  // must come from beat metadata (not synthetic import-* paths), and permanent
  // deletion is logically committed once while physical Telegram topic cleanup
  // runs from a durable background queue.
  const settingsPanel = readFileSync(path.join(root, "src", "components", "SettingsPanel.tsx"), "utf8");
  const rustCommands = readFileSync(path.join(root, "src-tauri", "src", "commands.rs"), "utf8");
  const cloudServer = readFileSync(path.join(root, "cloud-server", "server.js"), "utf8");

  const forbiddenEmptyRecovery = /if \(!settings\?\.telegram_cloud_connected\) return;\s*if \(beats\.length !== 0\) return;\s*void recoverTelegramLibraryOnceIfEmpty\(\);/;
  if (forbiddenEmptyRecovery.test(app)) fail("App.tsx reintroduced automatic Telegram recovery whenever beats becomes empty; Remove All can resurrect stale cards.");
  if (!app.includes('an empty library is a valid, authoritative state')) fail("App.tsx lost the empty-library mutation invariant comment; review Remove All recovery behavior.");
  if (!settingsPanel.includes("setTrashItems([]);")) fail("Settings Trash must disappear immediately after permanent-delete confirmation.");
  if (!settingsPanel.includes("Deleting ${requested} beat")) fail("Settings Trash lost its non-blocking background-delete status.");
  if (!settingsPanel.includes("const remaining = await listTrash();")) fail("Settings Trash must recover real rows if background deletion could not be queued.");
  if (!rustCommands.includes('metadata_display_name')) fail("Cloud Trash insertion must prefer BeatMeta.name over synthetic import-* paths.");
  if (!rustCommands.includes('beat_meta_json FROM trash ORDER BY trashed_at DESC')) fail("Trash listing must recover names from beat metadata for already-broken rows.");
  if (!rustCommands.includes('/beats/delete-topics-batch')) fail("Rust Trash purge must use the batch permanent-delete endpoint.");
  if (!rustCommands.includes('Snapshot the work first, release the DB')) fail("Manual Empty Trash must release SQLite before the Cloud/Telegram request.");
  if (!rustCommands.includes("pub async fn purge_trash_now")) fail("Empty Trash Tauri command must be async so Cloud/index I/O cannot block the UI thread.");
  if (!rustCommands.includes("tauri::async_runtime::spawn_blocking")) fail("Empty Trash blocking curl/index commit must run on Tauri spawn_blocking.");
  if (!rustCommands.includes("retrying automatically")) fail("Empty Trash must automatically retry one transient Cloud enqueue failure.");
  if (!cloudServer.includes('app.post("/beats/delete-topics-batch"')) fail("Cloud Server lost the batch permanent-delete endpoint.");
  if (!cloudServer.includes("pendingTopicDeletes.set")) fail("Cloud Trash must persist physical Telegram cleanup jobs before returning.");
  if (!cloudServer.includes("cleanup_background: true")) fail("Cloud Trash endpoint must advertise background physical cleanup.");
  if (!cloudServer.includes("function schedulePendingTopicDeletes")) fail("Cloud Trash lost the non-blocking background cleanup scheduler.");
  if (cloudServer.includes("await flushPendingTopicDeletes(account, beatgalerUserId)")) fail("Library requests must never block on physical Telegram Trash cleanup.");
  if (!cloudServer.includes("workerCount = Math.min(4")) fail("Background Telegram cleanup lost bounded concurrency.");
  if (!cloudServer.includes("TOPIC_ID_INVALID")) fail("Already-missing Telegram topics must count as successfully deleted, including TOPIC_ID_INVALID.");
  if (!rustCommands.includes("fn direct_permanently_delete_beats")) fail("Permanent delete must mutate the single index through the Desktop transport bot.");
  if (!rustCommands.includes('root.entry("deleted")')) fail("Direct permanent delete must retain tombstones in the single index so stale clients cannot resurrect deleted beats.");
  if (!rustCommands.includes("direct_replace_library_manifest(user_id, &manifest")) fail("Direct Trash mutations must publish through the transport bot.");
  if (!cloudServer.includes('Legacy server-side library index upload is disabled')) fail("MASTER/server library upsert must remain disabled in Direct mode.");
  if (!cloudServer.includes('index_owner: "desktop-transport-bot"')) fail("Permanent-delete Topic cleanup must acknowledge that the Desktop transport bot owns index mutation.");

  const emptyTrashBlock = settingsPanel.match(/const emptyTrash = \(\) => \{[\s\S]*?\n  \};\n  const emptyPresetTrash/);
  if (!emptyTrashBlock) fail("Could not locate Settings emptyTrash implementation.");
  if (emptyTrashBlock[0].includes("confirm(")) fail("Beat Empty Trash reintroduced a blocking native confirmation dialog.");
  if (!emptyTrashBlock[0].includes("void (async () =>")) fail("Beat Empty Trash must enqueue/reconcile in background without blocking the click handler.");
  console.log("PASS remove/trash guard: names are human-readable; Empty Trash never blocks UI, retries transient Cloud enqueue, and permanent deletes cannot resurrect");

  const playbackReadiness = readFileSync(path.join(root, "src", "features", "playback", "playbackReadiness.ts"), "utf8");
  if (!playbackReadiness.includes('"UPLOADING"') || !playbackReadiness.includes('"PLAYBACK_PREPARING"')) fail("Playback readiness gate lost one of its blocking upload states.");
  if (!beatCard.includes("if (playbackBlocked) return;")) fail("BeatCard must ignore Play clicks while upload/playback preparation is active.");
  if (!app.includes('PLAY_BLOCKED_LOADING')) fail("App handlePlay lost its defensive loading-state guard.");
  if (!app.includes('cloud_status: "PLAYBACK_PREPARING"')) fail("Background upload must enter PLAYBACK_PREPARING before advertising completion.");
  if (app.includes("beatsLatestRef.current = indexSnapshot;")) fail("Manifest serialization must not overwrite the live PLAYBACK_PREPARING state in beatsLatestRef.");
  const preparingIndex = app.indexOf('cloud_status: "PLAYBACK_PREPARING"');
  const readyGateIndex = app.indexOf("await waitForUploadedBeatPlaybackReady(detached)", preparingIndex);
  const completeIndex = app.indexOf('cloud_status: "UPLOAD_COMPLETE"', readyGateIndex);
  if (preparingIndex < 0 || readyGateIndex < 0 || completeIndex < 0 || !(preparingIndex < readyGateIndex && readyGateIndex < completeIndex)) fail("Upload completion must occur only after the real playback readiness gate.");
  if (!rustCommands.includes("Any explicit enqueue is a retry signal")) fail("Rust Download Cooking must revive transient post-upload failures on explicit warm retry.");
  console.log("PASS upload/play guard: first Play waits for real MASTER readiness and loading beats stay non-interactive");

  // Definitive beat runtime state architecture. These are independent machines,
  // not one overloaded status string, and they remain session-local by design.
  const runtimeStateMachine = readFileSync(path.join(root, "src", "features", "state", "beatRuntimeState.ts"), "utf8");
  for (const stateName of ["pending_upload", "uploading", "synced", "pending_update", "updating", "deleting", "error", "conflict", "downloading", "idle", "playback_preparing", "playing"]) {
    if (!runtimeStateMachine.includes(`"${stateName}"`)) fail(`Definitive runtime state missing: ${stateName}`);
  }
  if (!runtimeStateMachine.includes("offline_available: boolean")) fail("Available Offline was collapsed back into a mutually-exclusive status.");
  if (!runtimeStateMachine.includes("download_progress: number | null")) fail("Optional download progress runtime data was removed.");
  if (!runtimeStateMachine.includes("previous_state")) fail("Runtime errors no longer retain previous_state.");
  if (!runtimeStateMachine.includes("trash_sync_required")) fail("Offline Trash lost its explicit reconciliation bit.");
  if (!app.includes('transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }') || !app.includes('type: "SYNC_UPLOAD_STARTED"') || !app.includes('type: "PLAYBACK_PREPARING"') || !app.includes('type: "DOWNLOAD_STARTED"')) fail("App flows are no longer wired to the definitive runtime state machine.");
  if (!app.includes("const [beatRuntimeStates, setBeatRuntimeStates]")) fail("Runtime states were moved into persisted Beat metadata; transient work must stay session-local.");
  console.log("PASS runtime-state guard: sync/download/playback are independent, Offline is orthogonal, errors remember previous_state, and App flows are wired");

  // Bulk Import + instant Review regression shield. Review must become visible
  // before heavy per-beat preparation, metadata is prepared one beat at a time,
  // ambiguous folder audio is deferred, and retries reuse already-uploaded slots.
  const reviewSkeleton = readFileSync(path.join(root, "src", "components", "ReviewBeatSkeleton.tsx"), "utf8");
  const drawerSource = readFileSync(path.join(root, "src", "components", "Drawer.tsx"), "utf8");
  const audioConflictModal = readFileSync(path.join(root, "src", "components", "ImportAudioConflictsModal.tsx"), "utf8");
  const htmlDropController = readFileSync(path.join(root, "src", "features", "dragdrop", "htmlDropController.ts"), "utf8");
  if (!app.includes("const REVIEW_SKELETON_ENABLED = true")) fail("Instant Review lost the removable skeleton gate.");
  if (!app.includes("const [libraryDropStaging, setLibraryDropStaging]")) fail("Instant Review no longer covers the pre-import WebView2 staging window.");
  if (!app.includes("onLibraryFileStagingChange: active")) fail("App is no longer notified at the HTML fallback library-drop boundary.");
  if (!app.includes("windowsNativeDrop") || !app.includes("if (windowsNativeDrop) return")) fail("Windows can still enter the expensive HTML staging path.");
  if (!htmlDropController.includes("options.onLibraryFileStagingChange?.(true)")) fail("Non-Windows HTML fallback no longer opens Review feedback before fallback staging.");
  if (!htmlDropController.includes("requestAnimationFrame(() => window.setTimeout(resolve, 0))")) fail("Skeleton paint is no longer guaranteed before HTML fallback staging.");
  const dropSkeletonIndex = htmlDropController.indexOf("options.onLibraryFileStagingChange?.(true)");
  const stageBytesIndex = htmlDropController.indexOf("await stageCapturedHtmlDrop(capturedDrop)", dropSkeletonIndex);
  if (dropSkeletonIndex < 0 || stageBytesIndex < 0 || dropSkeletonIndex > stageBytesIndex) fail("HTML fallback must paint feedback before it stages bytes.");
  if (!app.includes("DataTransfer File.arrayBuffer(), no drop-staging")) fail("Windows native import lost its explicit no-staging critical-path invariant.");
  const skeletonIndex = app.indexOf("setReviewBootstrap({ total: null })");
  const streamStartIndex = app.indexOf("await startImportReviewStream(normalized)", skeletonIndex);
  if (skeletonIndex < 0 || streamStartIndex < 0 || skeletonIndex > streamStartIndex) fail("Review skeleton no longer appears before streaming discovery starts.");
  if (app.includes("await previewImportBatch(normalized)")) fail("Review regressed to full-batch discovery before Beat 1.");
  if (!app.includes("await prepareNextImportReviewBeat(stream.batch_id)")) fail("Review no longer advances the streaming discovery one beat at a time.");
  if (!app.includes("while (!step.discovery_complete") || !app.includes("FIRST_REVIEW_READY") || !app.includes("DISCOVERY_FINISHED")) fail("Streaming Review worker/perf instrumentation was removed.");
  if (!app.includes("reviewPreparationPromiseRef.current")) fail("Save All no longer shares the sequential Review preparation worker.");
  if (!app.includes("setReviewQueue(null);") || !app.includes("cloudifyImportedBeats([currentUpdated])")) fail("Save All must close Review and upload the current beat without waiting for the rest.");
  if (!app.includes("Retry upload") && !beatCard.includes("Retry upload")) fail("Individual failed-upload Retry disappeared.");
  if (!app.includes('cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }])')) fail("Individual Retry is no longer wired back into the checkpoint-aware upload pipeline.");
  if (!rustCommands.includes("pub fn start_import_review_stream") || !rustCommands.includes("VecDeque") || !rustCommands.includes("discover_next_stream_group")) fail("Rust lost true incremental/shallow-first import discovery.");
  if (!rustCommands.includes("pub fn prepare_next_import_review_beat")) fail("Rust lost one-at-a-time Review preparation.");
  if (!rustCommands.includes("pub fn get_import_review_batch_summary")) fail("Streaming discovery can no longer publish its final N/conflicts.");
  if (!rustCommands.includes("pub fn resolve_import_audio_conflict")) fail("Rust lost deferred audio conflict resolution.");
  if (!rustCommands.includes("directory_audio_by_parent")) fail("Legacy fallback no longer distinguishes ambiguous folder audio from explicitly-selected loose files.");
  if (!rustCommands.includes('kind: "main_audio".to_string()')) fail("Ambiguous same-folder main audio is no longer deferred to the conflict UI.");
  if (!rustCommands.includes("prepared_cores")) fail("Prepared Review cores are no longer protected from duplicate recreation by legacy decision resolution.");
  if (!rustCommands.includes("playable_confirmed")) fail("Project-only discovery can re-enter Review and fail with No playable audio.");
  if (!rustCommands.includes("final_cloud_display_name_after_review")) fail("Bulk upload lost its Telegram-authoritative duplicate-name gate.");
  if (!reviewSkeleton.includes('right: 0') || !reviewSkeleton.includes('width: 340')) fail("Review skeleton no longer mirrors the existing right-side Review Drawer.");
  if (!drawerSource.includes("Skip beat") || !drawerSource.includes("Cancel import")) fail("Review no longer separates skipping one candidate from cancelling the remaining import.");
  if (!audioConflictModal.includes("Choose the main audio")) fail("Audio conflict UI no longer lets the user choose the main audio.");
  if (!audioConflictModal.includes("Skip this beat") || !audioConflictModal.includes("__skip__")) fail("One unwanted audio conflict can cancel the whole batch again.");
  if (!audioConflictModal.includes("for (const conflict of conflicts)")) fail("Audio conflicts are no longer resolved deterministically one at a time.");
  const telegramRetry = readFileSync(path.join(root, "cloud-server", "telegram-retry.js"), "utf8");
  if (!cloudServer.includes('withTelegramFloodWait')) fail("Telegram 429 flood-wait handling disappeared from the cloud server.");
  if (!telegramRetry.includes("retry\\s+after") || !telegramRetry.includes("retry_after")) fail("Telegram retry helper no longer understands Bot API retry_after responses.");
  console.log("PASS bulk/review guard: Tauri native zero-copy Windows local drop, right-side skeleton, streaming shallow-first discovery, per-beat skip, playable-only Review, deferred conflicts, checkpoint retry, Telegram flood-wait, and authoritative final sync");

  // Offline/Reconnect regression shield. Offline availability is a durable,
  // per-user desktop pin, never ordinary playback cache and never web metadata.
  // Cold offline starts may expose only validated pins; ordinary cached cards
  // are allowed to survive only until the current app process closes.
  if (!app.includes('loadOfflineLibrary()')) fail("Cold Offline startup lost native durable-library validation.");
  if (!app.includes('if (connectionState === "checking")')) fail("Startup can reveal cached cards before connectivity has been verified.");
  if (!app.includes('if (!status.reachable)')) fail("Offline startup/reconnect lost explicit Telegram transport reachability.");
  if (!app.includes('const [beats, setBeats] = useState<Beat[]>([]);')) fail("Cold Offline startup can render ordinary cached cloud cards before verification again.");
  if (!app.includes('setRevealedBeatIds(new Set(offline.map(beat => beat.id)))')) fail("Validated Offline beats no longer resolve the startup reveal atomically.");
  if (!app.includes('BeatGaler does not import new beats while offline')) fail("Offline mode re-enabled beat imports.");
  if (!app.includes('const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000]')) fail("Reconnect/upload preflight lost the bounded 1s→60s backoff sequence.");
  if (!beatCard.includes('Make available offline') || !beatCard.includes('offlineAvailablePng')) fail("Beat cards lost Offline pin controls or the supplied Offline artwork symbol.");
  if (beatCard.includes('>✓</span>') || beatCard.includes('>↧</span>')) fail("Legacy Offline text glyphs (green check/orange arrow) were reintroduced.");
  if (!settingsPanel.includes('Connect to the internet before permanently emptying beat Trash.')) fail("Beat Trash can be permanently emptied offline again.");
  const rustVersioning = readFileSync(path.join(root, "src-tauri", "src", "versioning.rs"), "utf8");
  if (!rustCommands.includes('CREATE TABLE IF NOT EXISTS offline_beats') && !rustVersioning.includes('CREATE TABLE IF NOT EXISTS offline_beats')) fail("SQLite lost durable per-user Offline records.");
  if (!rustCommands.includes('FROM offline_beats WHERE user_id=?1 ORDER BY created_at, beat_id')) fail("Cold Offline library depends on ordinary beats cache again instead of durable Offline records.");
  if (!rustCommands.includes('Offline packages live under app_data/offline')) fail("Clear cache lost the explicit Offline-storage separation invariant.");
  if (!rustCommands.includes('The Rust cooker survives a WebView refresh')) fail("Clear cache no longer resets stale in-memory Download Cooking state.");
  if (!tauriClient.includes('beatgaler:playback-cache-cleared')) fail("Clear cache no longer invalidates the WebView Fast Play memo.");
  if (!app.includes('playbackCacheEpochRef.current += 1') || !app.includes('cookingPlaybackUrlRef.current.clear()')) fail("Clear cache can leave stale Fast Play URLs alive in App.tsx.");
  if (!app.includes('playbackCacheEpochRef.current !== cacheEpoch')) fail("A pre-Clear-cache warm promise can repopulate a stale playback URL.");
  if (!rustCommands.includes('state.data_dir.join("offline")')) fail("Offline files are no longer stored outside temporary playback cache.");
  if (!rustCommands.includes('ARTWORK:{}:{}') || !rustCommands.includes('PROJECT:{}') || !rustCommands.includes('FILE:{}:{}:{}')) fail("Offline fingerprint no longer tracks artwork/project/file source changes for future refresh logic.");
  if (!rustCommands.includes('Explicit Offline pins outrank temporary cache and network streaming.')) fail("Playback lost durable Offline precedence.");
  if (!rustCommands.includes('fn direct_move_beats_to_trash')) fail("Offline Trash intents lost Direct current-index reconciliation.");
  if (!rustCommands.includes('direct_move_beats_to_trash(&user_id, &beat_ids)')) fail("Offline Trash intents must reconcile through the active Desktop transport bot.");
  if (!cloudServer.includes('telegramTransportReachable')) fail("Cloud status lost runtime Telegram reachability probing.");
  if (!cloudServer.includes('telegramPublicEdgeReachable')) fail("Connectivity must probe Telegram's public edge; a local Bot API response is not enough.");
  if (cloudServer.includes('telegramReachabilityProbe = { checkedAt:')) fail("Connectivity reintroduced a stale positive reachability cache across Wi-Fi/app restart transitions.");
  if (!cloudServer.includes('telegramTransportReachable(null)')) fail("Unlinked-vs-offline status is ambiguous again when no linked account is in server memory.");
  const startupReachableIndex = app.indexOf('if (!status.reachable)', app.indexOf('Telegram startup connectivity check failed'));
  const startupConnectedIndex = app.indexOf('if (!status.connected)', app.indexOf('Telegram startup connectivity check failed'));
  if (startupReachableIndex < 0 || startupConnectedIndex < 0 || startupReachableIndex > startupConnectedIndex) fail("Cold start must decide reachability before treating connected:false as logout.");
  if (!rustCommands.includes('else if reachable {\n        settings.telegram_cloud_connected = false;')) fail("Native status reconciliation can still log the account out while Telegram is unreachable.");
  const loadLibraryStart = rustCommands.indexOf('pub fn load_library(');
  const loadLibraryEnd = rustCommands.indexOf('pub fn write_meta(', loadLibraryStart);
  const loadLibraryBlock = loadLibraryEnd > loadLibraryStart ? rustCommands.slice(loadLibraryStart, loadLibraryEnd) : rustCommands.slice(loadLibraryStart, loadLibraryStart + 5000);
  if (loadLibraryBlock.includes('clear_offline_record(')) fail("Online library load must never delete a durable Offline package because of a transient fingerprint mismatch.");
  if (!loadLibraryBlock.includes('offline_record_available(')) fail("Online library load no longer preserves durable Offline availability.");
  if (!rustCommands.includes('if let Some((master_path, _)) = offline_record_available')) fail("Pinned playback can still reject its durable MASTER because cloud metadata changed during reconnect.");
  if (!rustCommands.includes('direct_download_range_with_retry') || !rustCommands.includes('Telegram Direct range retry exhausted')) fail("Download Cooking lost transient reconnect retry for Direct MASTER ranges.");
  if (cloudServer.includes('TEST: MASTER missing from cloud')) fail("Production MASTER streaming still contains a hard-coded test 404 fault injection.");
  if (!rustCommands.includes('preserves newer edits from another online device')) fail("Offline Trash reconciliation no longer documents current-online-wins behavior.");
  const openProjectStart = rustCommands.indexOf("pub fn open_beat_project(");
  const openProjectEnd = rustCommands.indexOf("pub fn download_project_to_cache", openProjectStart);
  if (openProjectStart < 0 || openProjectEnd < 0) fail("Could not locate open_beat_project for Offline regression coverage.");
  const openProjectBlock = rustCommands.slice(openProjectStart, openProjectEnd);
  if (openProjectBlock.includes('if !settings.telegram_cloud_connected')) fail("Open Project reintroduced a hard online requirement even when a durable Offline PROJECT exists.");
  if (!app.includes('beat.offline_available && (beat.has_flp || beat.has_als)')) fail("Offline PROJECT cards can lose Open Project merely because the cloud-project indicator has not refreshed.");
  if (app.includes('rejectOfflineMutation("Downloading cloud files")')) fail("Available Offline exports are incorrectly blocked as an offline mutation.");
  if (!app.includes('This beat was not made Available Offline. Reconnect to download its cloud files.')) fail("Offline Download must distinguish a protected local package from a cloud-only beat.");
  if (!rustCommands.includes('The incoming Offline BeatMeta is the authoritative LOCAL source map for')) fail("Export metadata resolution can discard durable Offline file paths again.");
  if (!rustCommands.includes('Available Offline owns a protected MASTER outside the temporary cache.')) fail("MP3 export lost local-first Offline precedence.");
  if (!rustCommands.includes('PROJECT follows the same local-first rule. Available Offline must')) fail("PROJECT/Everything export lost local-first Offline precedence.");
  if (!app.includes('assets/status/upload-complete.wav') || !app.includes('assets/status/download-complete.wav')) fail("User-supplied upload/download completion sounds are not wired into App.tsx.");
  if (!app.includes('cookingPlaybackUrlRef.current.delete(beat.id)')) fail("Remove from Available Offline can leave a dead durable MASTER URL in the Fast Play Path.");
  if (!app.includes('cookingWarmPromisesRef.current.delete(beat.id)')) fail("Remove from Available Offline can reuse a stale Offline warm promise instead of re-entering Cloud cooking.");
  if (!app.includes('const canonical = await loadLibrary();')) fail("Remove from Available Offline no longer rehydrates canonical cloud BeatMeta after deleting local-only paths.");
  const removeOfflineStart = rustCommands.indexOf('pub fn remove_beat_offline_availability(');
  const removeOfflineEnd = rustCommands.indexOf('#[tauri::command]', removeOfflineStart + 1);
  const removeOfflineBlock = removeOfflineEnd > removeOfflineStart ? rustCommands.slice(removeOfflineStart, removeOfflineEnd) : '';
  if (!removeOfflineBlock.includes('std::fs::remove_dir_all(root_path)')) fail("Remove from Available Offline no longer deletes the durable package.");
  if (removeOfflineBlock.indexOf('clear_offline_record(') < removeOfflineBlock.indexOf('std::fs::remove_dir_all(root_path)')) fail("Offline SQLite state is cleared before durable-file deletion succeeds, which can leave removal half-applied.");
  console.log("PASS offline/reconnect guard: durable Offline pins, verified cold-start filtering, cache-safe pins, local MP3/WAV/PROJECT exports, Open Project, safe Offline removal, reconnect playback recovery, supplied icon/sounds, and safe Trash reconciliation");


  // Phase 10: Downloads + PROJECT lifecycle. Protect the worker-thread boundary,
  // local-first Offline behavior, atomic exports, unique Everything folders,
  // PROJECT validation/download/open lifecycle, and user-visible completion/error state.
  const phase10Start = rustCommands.indexOf('pub fn start_background_download(');
  const phase10End = rustCommands.indexOf('pub fn copy_audio_metadata(', phase10Start);
  if (phase10Start < 0 || phase10End < 0) fail("Phase 10 download worker could not be located.");
  const phase10Worker = rustCommands.slice(phase10Start, phase10End);
  if (!phase10Worker.includes('std::thread::spawn(move ||')) fail("Phase 10 downloads can block the Tauri UI thread again.");
  for (const kind of ['"MP3"', '"WAV"', '"PROJECT"', '"ALL"']) {
    if (!phase10Worker.includes(kind)) fail(`Phase 10 download worker lost ${kind}.`);
  }
  if (!phase10Worker.includes('ensure_master_export_cache')) fail("MP3 export lost durable/cache source resolution.");
  if (!phase10Worker.includes('cloud_file_id_for_beat(&conn, &beat.id, "WAV")')) fail("WAV export lost its exact HQ cloud slot lookup.");
  if (!phase10Worker.includes('ensure_project_working_copy')) fail("PROJECT export lost local/download working-copy resolution.");
  if (!phase10Worker.includes('prepare_unique_export_folder')) fail("Download Everything can overwrite an older export folder again.");
  if (!phase10Worker.includes('write_beat_metadata_to_exported_audio')) fail("Audio exports lost current BeatGaler metadata overlay.");
  if (!phase10Worker.includes('background_download_emit') || !phase10Worker.includes('"completed"') || !phase10Worker.includes('"error"')) fail("Background download completion/error events disappeared.");
  const atomicExportStart = rustCommands.indexOf('pub fn copy_export_file(');
  const atomicExportEnd = rustCommands.indexOf('fn safe_export_component', atomicExportStart);
  const atomicExport = rustCommands.slice(atomicExportStart, atomicExportEnd);
  if (!atomicExport.includes('.beatgaler-export')) fail("Exports no longer stage through a temporary file before finalization.");
  if (!atomicExport.includes('source_meta.len() == 0')) fail("Empty/corrupt export sources are no longer rejected before replacing the destination.");
  const openProjectStart10 = rustCommands.indexOf('pub fn open_beat_project(');
  const openProjectEnd10 = rustCommands.indexOf('pub fn download_project_to_cache', openProjectStart10);
  const openProject10 = rustCommands.slice(openProjectStart10, openProjectEnd10);
  if (!openProject10.includes('ensure_project_working_copy')) fail("Open Project no longer downloads/reuses the canonical PROJECT working copy.");
  if (!rustCommands.includes('if !project_zip_is_valid(&workspace)')) fail("Downloaded PROJECT ZIP is no longer validated before use.");
  if (!rustCommands.includes('project-workspaces')) fail("PROJECT working copies lost their isolated temporary workspace.");
  if (!app.includes('startBackgroundDownload(kind, beat, destination)')) fail("Downloads UI no longer starts the native background worker.");
  if (!app.includes('listen<BackgroundDownloadEvent>("beatgaler-download-event"')) fail("Downloads UI lost native completion/error event handling.");
  if (!app.includes('next.add(kind)')) fail("Download completion status no longer marks only the action the user actually requested.");
  console.log("PASS Phase 10 downloads/project guard: background worker, atomic exports, unique Everything folders, local-first slots, PROJECT validation/open, and completion/error UI are protected");

  // Phase 11: recovery/corruption guard. A crash marker is never authority,
  // canonical INDEX wins, incomplete downloads/exports stay sidecar-only,
  // corrupt payloads fail closed, and durable control-plane state is atomic.
  if (!app.includes("const INTERRUPTED_UPLOADS_KEY")) fail("Interrupted upload recovery marker disappeared.");
  if (!app.includes("authoritativeBeatIds?.has(item.beatId)")) fail("Upload recovery can no longer preserve a beat already committed to the authoritative INDEX.");
  if (!app.includes("authoritativeBeatIds === null")) fail("Upload recovery no longer fails closed when the authoritative INDEX cannot be verified.");
  if (!app.includes("remaining.push(item)")) fail("Failed upload rollback no longer keeps its recovery marker for a later launch.");
  const directDownloadStart11 = rustCommands.indexOf("fn download_telegram_file_to_path(");
  const directDownloadEnd11 = rustCommands.indexOf("fn download_beat_from_telegram_inner", directDownloadStart11);
  const directDownload11 = rustCommands.slice(directDownloadStart11, directDownloadEnd11);
  if (!directDownload11.includes("beatgaler-download")) fail("Native downloads lost their crash-safe sidecar file.");
  if (directDownload11.indexOf("downloaded_size == 0") > directDownload11.indexOf("remove_file(destination)")) fail("Download destination can be removed before corruption/empty-file validation.");
  if (!directDownload11.includes("remove_file(&tmp_path)")) fail("Failed native downloads can leave stale sidecars behind.");
  const exportStart11 = rustCommands.indexOf("pub fn copy_export_file(");
  const exportEnd11 = rustCommands.indexOf("fn safe_export_component", exportStart11);
  const export11 = rustCommands.slice(exportStart11, exportEnd11);
  if (export11.indexOf("source_meta.len() == 0") > export11.indexOf("remove_file(&destination)")) fail("Export destination can be removed before source integrity validation.");
  if (!export11.includes("beatgaler-export")) fail("Exports lost their temporary sidecar boundary.");
  if (!rustCommands.includes("Reconstructed project ZIP is empty.")) fail("PROJECT reconstruction no longer rejects empty/corrupt output.");
  if (!rustCommands.includes("Project download worker") || !rustCommands.includes("remove_dir_all(&part_dir)")) fail("PROJECT worker crash cleanup disappeared.");
  if (!rustCommands.includes(".tag-rename-journal") || !rustCommands.includes("rollback_incomplete_tag_rename")) fail("Crash-safe tag mutation journal/recovery disappeared.");
  const transportPool = readFileSync(path.join(root, "cloud-server", "transport-pool.js"), "utf8");
  if (!transportPool.includes("const tmp = `${file}.tmp`") || !transportPool.includes("fs.renameSync(tmp, file)")) fail("Transport pool durable state is no longer written temp+rename atomically.");
  console.log("PASS Phase 11 recovery/corruption guard: authoritative INDEX wins recovery, sidecar writes fail closed, corrupt outputs are rejected, journals roll back, and pool state stays atomic");

  execFileSync(process.execPath, [path.join(root, "scripts", "regression-phase12.mjs")], {
    cwd: root,
    stdio: "inherit",
  });

  execFileSync(process.execPath, [path.join(root, "scripts", "regression-phase12b.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(root, "scripts", "regression-phase12c.mjs")], {
    cwd: root,
    stdio: "inherit",
  });

  execFileSync(process.execPath, [path.join(root, "scripts", "version.mjs"), "check"], {
    cwd: root,
    stdio: "inherit",
  });

  const macWorkflow = readFileSync(path.join(root, ".github", "workflows", "build-macos-cloud-beta.yml"), "utf8");
  if (/galer-cloud-beta-v\d+/i.test(macWorkflow)) fail("macOS cloud beta workflow reintroduced a version-specific branch.");
  if (/BeatGaler-V\d+-macOS/i.test(macWorkflow)) fail("macOS artifact name reintroduced a version-specific hardcode.");
  if (!macWorkflow.includes("npm run version:check")) fail("macOS workflow must verify VERSION before building.");
  console.log("PASS release guard: macOS workflow builds the selected ref without a hardcoded V-number");
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

// GitHub publishing guard: branch names must come from VERSION and pushes must use an
// explicit heads refspec so a same-named tag can never recreate the old refspec collision.
{
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const githubSave = readFileSync(path.join(root, "scripts", "github-save.mjs"), "utf8");
  if (packageJson.scripts?.["github:save"] !== "node scripts/github-save.mjs") fail("package.json lost the one-command github:save entry point.");
  if (packageJson.scripts?.["github:branch"] !== "node scripts/github-save.mjs --print-branch") fail("package.json lost the github:branch preview command.");
  if (!githubSave.includes('readFileSync(path.join(root, "VERSION")')) fail("github-save.mjs must derive its branch from VERSION.");
  if (!githubSave.includes("HEAD:refs/heads/${branch}")) fail("github-save.mjs must push with an explicit refs/heads refspec.");
  if (/--force(?:-with-lease)?\b/.test(githubSave)) fail("github-save.mjs must never force-push automatically.");

  const version = readFileSync(path.join(root, "VERSION"), "utf8").trim();
  const stable = version.match(/^(\d+\.\d+\.\d+)/)?.[1];
  const expected = /-beta(?:\.|$)/i.test(version) ? `galer-cloud-beta-v${stable}` : `galer-cloud-v${stable}`;
  const actual = execFileSync(process.execPath, [path.join(root, "scripts", "github-save.mjs"), "--print-branch"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (actual !== expected) fail(`GitHub branch derivation mismatch. Expected ${expected}, got ${actual}.`);
  console.log(`PASS github guard: one command targets ${actual} from VERSION without force-push`);
}
