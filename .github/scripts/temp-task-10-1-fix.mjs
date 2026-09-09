import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one match for ${label ?? before}, found ${count}`);
  return source.replace(before, after);
}

function patchFile(path, patches) {
  let source = fs.readFileSync(path, 'utf8');
  for (const [before, after, label] of patches) source = replaceOnce(source, before, after, label);
  fs.writeFileSync(path, source);
}

const shellPath = 'src/app/AppShell.tsx';
let text = fs.readFileSync(shellPath, 'utf8');
const replacements = [
  ['interruptedUploadNotices.map(name =>', 'interruptedUploadNotices.map((name: string) =>'],
  ['displayedBeats.every(b =>', 'displayedBeats.every((b: import("../types").Beat) =>'],
  ['allTags.map(t =>', 'allTags.map((t: string) =>'],
  ['filteredBeats.map((b) => b.id)', 'filteredBeats.map((b: import("../types").Beat) => b.id)'],
  ['filteredBeats.map((beat, i) => (', 'filteredBeats.map((beat: import("../types").Beat, i: number) => ('],
  ['beats.some(existing =>', 'beats.some((existing: import("../types").Beat) =>'],
];
for (const [before, after] of replacements) text = replaceOnce(text, before, after);
fs.writeFileSync(shellPath, text);

patchFile('tests/component-dom/startupRevealArchitecture.test.ts', [
  ['const app = readFileSync("src/App.tsx", "utf8");', 'const app = readFileSync("src/App.tsx", "utf8");\nconst appShell = readFileSync("src/app/AppShell.tsx", "utf8");'],
  ['expect(app).toContain("<SortableContext items={filteredBeats.map((b) => b.id)}");', 'expect(appShell).toContain("<SortableContext items={filteredBeats.map(");'],
  ['expect(app).toContain("visible={revealedBeatIds.has(beat.id)}");', 'expect(appShell).toContain("visible={revealedBeatIds.has(beat.id)}");'],
  ['expect(app).toContain(\'interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}\');', 'expect(appShell).toContain(\'interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}\');'],
  ['expect(app).toContain(\'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}\');', 'expect(appShell).toContain(\'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}\');'],
  ['expect(app).toContain(\'cloudSessionVerified && connectionState === "online" ? (\');', 'expect(appShell).toContain(\'cloudSessionVerified && connectionState === "online" ? (\');'],
]);

patchFile('tests/integration/issue97RuntimeWebFollowup.test.ts', [[
  '    const app = source("src/App.tsx");\n    const card = source("src/components/BeatCard.tsx");\n    expect(app).toContain(\'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}\');',
  '    const appShell = source("src/app/AppShell.tsx");\n    const card = source("src/components/BeatCard.tsx");\n    expect(appShell).toContain(\'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}\');'
]]);

patchFile('tests/integration/appBeatDownloadsExtraction.test.ts', [
  ['const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");', 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app).toContain("onClose={closeCloudFiles}");', 'expect(appShell).toContain("onClose={closeCloudFiles}");'],
]);

patchFile('tests/integration/appCloudUploadQueueExtraction.test.ts', [
  ['const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");', 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app).toContain("onRetryUpload={retryBackgroundUpload}");', 'expect(appShell).toContain("onRetryUpload={retryBackgroundUpload}");'],
]);

patchFile('tests/integration/appImportSaveAllExtraction.test.ts', [
  ['const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");', 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app).toContain("<ImportResolutionHost");', 'expect(appShell).toContain("<ImportResolutionHost");'],
]);

patchFile('tests/integration/appLibraryReloadExtraction.test.ts', [
  ['const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");', 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app).toContain("disabled={loading || libraryRefreshing}");', 'expect(appShell).toContain("disabled={loading || libraryRefreshing}");'],
  ['expect(app).toContain(\'animation: libraryRefreshing ? "beatgaler-refresh-spin .62s linear infinite" : "none"\');', 'expect(appShell).toContain(\'animation: libraryRefreshing ? "beatgaler-refresh-spin .62s linear infinite" : "none"\');'],
  ['expect(app).toContain("clearUploadPreviewCache(); void reloadLibrary();");', 'expect(appShell).toContain("clearUploadPreviewCache(); void reloadLibrary();");'],
  ['expect(app).toContain(\n      \'title={deferredLibraryReloadRef.current ? "Reload queued until uploads finish" : "Reload Library"}\'\n    );', 'expect(appShell).toContain(\n      \'title={deferredLibraryReloadRef.current ? "Reload queued until uploads finish" : "Reload Library"}\'\n    );'],
]);

patchFile('tests/integration/appMigrationCharacterization.test.ts', [
  ['const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");', 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app).toContain("<ImportReviewHost");', 'expect(appShell).toContain("<ImportReviewHost");'],
]);

patchFile('tests/integration/appSessionExtraction.test.ts', [
  ['const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");', 'const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");\nconst appShell = fs.readFileSync(path.join(root, "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app).toContain("onIncompleteWarningsChanged={handleIncompleteWarningsChanged}");', 'expect(appShell).toContain("onIncompleteWarningsChanged={handleIncompleteWarningsChanged}");'],
  ['expect(app).toContain("onCustomCursorChanged={handleCustomCursorChanged}");', 'expect(appShell).toContain("onCustomCursorChanged={handleCustomCursorChanged}");'],
  ['expect(app).toContain("onFolderChanged={handleFolderChanged}");', 'expect(appShell).toContain("onFolderChanged={handleFolderChanged}");'],
  ['expect(app).toContain("onDisconnectTelegram={handleDisconnectTelegramAccount}");', 'expect(appShell).toContain("onDisconnectTelegram={handleDisconnectTelegramAccount}");'],
]);

patchFile('tests/integration/appTagRenameExtraction.test.ts', [
  ['const app = fs.readFileSync("src/App.tsx", "utf8");', 'const app = fs.readFileSync("src/App.tsx", "utf8");\nconst appShell = fs.readFileSync("src/app/AppShell.tsx", "utf8");'],
  ["expect(app).toContain('<TagRenameDialog');", "expect(appShell).toContain('<TagRenameDialog');"],
]);

patchFile('tests/integration/issue97DrawerWebRoutingContract.test.ts', [
  ['const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");', 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app.split(marker).length - 1).toBe(2);', 'expect(appShell.split(marker).length - 1).toBe(2);'],
]);

patchFile('tests/integration/selectionReorderExtraction.test.ts', [
  ['const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");', 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");'],
  ['expect(app).toContain("toggleSelection(b, e.shiftKey, filteredBeats)");', 'expect(appShell).toContain("toggleSelection(b, e.shiftKey, filteredBeats)");'],
]);

patchFile('scripts/run-regressions.mjs', [
  ['  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");', '  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");\n  const appShell = readFileSync(path.join(root, "src", "app", "AppShell.tsx"), "utf8");'],
  ['  if (!app.includes(\'useTrashActions({\') || !app.includes(\'onBeatRestored={handleBeatRestored}\')) fail("App.tsx is no longer wired to the extracted Trash actions owner.");', '  if (!app.includes(\'useTrashActions({\') || !appShell.includes(\'onBeatRestored={handleBeatRestored}\')) fail("App/AppShell no longer compose the extracted Trash actions owner.");'],
]);
