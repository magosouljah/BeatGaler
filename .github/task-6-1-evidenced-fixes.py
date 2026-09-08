from pathlib import Path

app_path = Path("src/App.tsx")
app = app_path.read_text()
old_import = "downloadCloudFileToCache, downloadProjectToCache, revealInExplorer,"
new_import = "listCloudFilesForBeat, downloadCloudFileToCache, downloadProjectToCache, revealInExplorer,"
if app.count(old_import) != 1:
    raise SystemExit("Could not restore shared listCloudFilesForBeat import exactly once")
app_path.write_text(app.replace(old_import, new_import, 1))

downloads_path = Path("src/features/downloads/useBeatDownloads.ts")
downloads = downloads_path.read_text()
old_builder = '''  return {
    safeBase,
    audioSafeBase: exportMeta && !safeBase.endsWith(`[${exportMeta}]`)
      ? `${safeBase} [${exportMeta}]`
      : safeBase,
  };
'''
new_builder = '''  const audioSafeBase = exportMeta && !safeBase.endsWith(`[${exportMeta}]`)
    ? `${safeBase} [${exportMeta}]`
    : safeBase;
  return { safeBase, audioSafeBase };
'''
if downloads.count(old_builder) != 1:
    raise SystemExit("Could not preserve the original [BPM Key] filename builder exactly once")
downloads_path.write_text(downloads.replace(old_builder, new_builder, 1))

regressions_path = Path("scripts/run-regressions.mjs")
regressions = regressions_path.read_text()

runtime_marker = '  const runtimeStateMachine = readFileSync(path.join(root, "src", "features", "state", "beatRuntimeState.ts"), "utf8");'
runtime_owner_line = '  const beatDownloadsForRuntime = readFileSync(path.join(root, "src", "features", "downloads", "useBeatDownloads.ts"), "utf8");'
if regressions.count(runtime_marker) != 1:
    raise SystemExit("Could not find runtime state regression marker exactly once")
regressions = regressions.replace(runtime_marker, runtime_marker + "\n" + runtime_owner_line, 1)
old_runtime_guard = '  if (!app.includes(\'transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }\') || !app.includes(\'type: "SYNC_UPLOAD_STARTED"\') || !app.includes(\'type: "PLAYBACK_PREPARING"\') || !app.includes(\'type: "DOWNLOAD_STARTED"\')) fail("App flows are no longer wired to the definitive runtime state machine.");'
new_runtime_guard = '  if (!app.includes(\'transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }\') || !app.includes(\'type: "SYNC_UPLOAD_STARTED"\') || !app.includes(\'type: "PLAYBACK_PREPARING"\') || !beatDownloadsForRuntime.includes(\'type: "DOWNLOAD_STARTED"\')) fail("App flows are no longer wired to the definitive runtime state machine.");'
if regressions.count(old_runtime_guard) != 1:
    raise SystemExit("Could not move runtime download guard exactly once")
regressions = regressions.replace(old_runtime_guard, new_runtime_guard, 1)

marker = '  const rustCommandsForExport = readFileSync(path.join(root, "src-tauri", "src", "commands.rs"), "utf8");'
owner_line = '  const beatDownloadsForExport = readFileSync(path.join(root, "src", "features", "downloads", "useBeatDownloads.ts"), "utf8");'
if regressions.count(marker) != 1:
    raise SystemExit("Could not find export regression owner marker exactly once")
regressions = regressions.replace(marker, owner_line + "\n" + marker, 1)
replacements = [
    ('if (!app.includes("const audioSafeBase = exportMeta"))', 'if (!beatDownloadsForExport.includes("const audioSafeBase = exportMeta"))'),
    ("if (!app.includes('chooseExportFilePath(`${audioSafeBase}.mp3`'))", "if (!beatDownloadsForExport.includes('chooseExportFilePath(`${audioSafeBase}.mp3`'))"),
    ("if (!app.includes('chooseExportFilePath(`${audioSafeBase}.wav`'))", "if (!beatDownloadsForExport.includes('chooseExportFilePath(`${audioSafeBase}.wav`'))"),
    ("if (!app.includes('This beat was not made Available Offline. Reconnect to download its cloud files.'))", "if (!beatDownloadsForRuntime.includes('This beat was not made Available Offline. Reconnect to download its cloud files.'))"),
    ("if (!app.includes('assets/status/upload-complete.wav') || !app.includes('assets/status/download-complete.wav'))", "if (!app.includes('assets/status/upload-complete.wav') || !beatDownloadsForRuntime.includes('assets/status/download-complete.wav'))"),
    ("if (!app.includes('startBackgroundDownload(kind, beat, destination)'))", "if (!beatDownloadsForRuntime.includes('startBackgroundDownload(kind, beat, destination)'))"),
    ("if (!app.includes('listen<BackgroundDownloadEvent>(\"beatgaler-download-event\"'))", "if (!beatDownloadsForRuntime.includes('listen<BackgroundDownloadEvent>(\"beatgaler-download-event\"'))"),
    ("if (!app.includes('next.add(kind)'))", "if (!beatDownloadsForRuntime.includes('next.add(tracked.kind)'))"),
]
for old, new in replacements:
    if regressions.count(old) != 1:
        raise SystemExit(f"Could not move download regression guard exactly once: {old}")
    regressions = regressions.replace(old, new, 1)
regressions_path.write_text(regressions)
