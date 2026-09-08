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
marker = '  const rustCommandsForExport = readFileSync(path.join(root, "src-tauri", "src", "commands.rs"), "utf8");'
owner_line = '  const beatDownloadsForExport = readFileSync(path.join(root, "src", "features", "downloads", "useBeatDownloads.ts"), "utf8");'
if regressions.count(marker) != 1:
    raise SystemExit("Could not find export regression owner marker exactly once")
regressions = regressions.replace(marker, owner_line + "\n" + marker, 1)
replacements = [
    ('if (!app.includes("const audioSafeBase = exportMeta"))', 'if (!beatDownloadsForExport.includes("const audioSafeBase = exportMeta"))'),
    ("if (!app.includes('chooseExportFilePath(`${audioSafeBase}.mp3`'))", "if (!beatDownloadsForExport.includes('chooseExportFilePath(`${audioSafeBase}.mp3`'))"),
    ("if (!app.includes('chooseExportFilePath(`${audioSafeBase}.wav`'))", "if (!beatDownloadsForExport.includes('chooseExportFilePath(`${audioSafeBase}.wav`'))"),
]
for old, new in replacements:
    if regressions.count(old) != 1:
        raise SystemExit(f"Could not move export regression guard exactly once: {old}")
    regressions = regressions.replace(old, new, 1)
regressions_path.write_text(regressions)
