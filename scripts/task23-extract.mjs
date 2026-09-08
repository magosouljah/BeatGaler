import { readFileSync, writeFileSync } from "node:fs";
import * as ts from "typescript";

const appPath = "src/App.tsx";
let app = readFileSync(appPath, "utf8");

function once(oldText, newText, label) {
  const count = app.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly 1 anchor, found ${count}`);
  app = app.replace(oldText, newText);
}

once(
  'import { startupCacheContext } from "./features/perf/directStartupDiagnostics";\n',
  "",
  "startup cache context import"
);

once(
  'import TagColorMenu from "./features/tags/components/TagColorMenu";',
  `import TagColorMenu from "./features/tags/components/TagColorMenu";
import { decodeArtworkDataUrl } from "./features/artwork/decodeArtworkDataUrl";
import { clearCloudUploadActive, markCloudUploadActive, readActiveCloudUploads, writeActiveCloudUploads, type ActiveCloudUpload } from "./features/cloud/interruptedUploadJournal";
import { extensionFromPath, fileNameFromPath, isBackupFolderPath } from "./features/dragdrop/pathHelpers";
import { cloudBeatFingerprint, drawerMetadataCommitFingerprint, libraryViewFingerprint } from "./features/library/libraryFingerprints";
import { clearCachedBeats, clearUploadPreviewCache, loadCachedBeats, loadCachedSort, preserveLoadedArtwork, saveCachedBeats, saveCachedSort } from "./features/library/libraryPresentationCache";`,
  "2.3 helper imports"
);

const sourceFile = ts.createSourceFile(appPath, app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functionNames = new Set([
  "fileNameFromPath",
  "extensionFromPath",
  "isBackupFolderPath",
  "activeUploadStagingPaths",
  "readActiveCloudUploads",
  "writeActiveCloudUploads",
  "markCloudUploadActive",
  "clearCloudUploadActive",
  "loadCachedBeats",
  "saveCachedBeats",
  "cloudBeatFingerprint",
  "drawerMetadataCommitFingerprint",
  "libraryViewFingerprint",
  "loadCachedSort",
  "saveCachedSort",
  "preserveLoadedArtwork",
  "clearUploadPreviewCache",
  "decodeArtworkDataUrl",
]);
const requiredConstants = new Set(["LIBRARY_CACHE_KEY", "SORT_CACHE_KEY", "INTERRUPTED_UPLOADS_KEY"]);
const ranges = [];
const foundFunctions = new Set();
const foundConstants = new Set();
let foundActiveCloudUpload = false;

for (const statement of sourceFile.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name && functionNames.has(statement.name.text)) {
    foundFunctions.add(statement.name.text);
    ranges.push({ start: statement.getFullStart(), end: statement.getEnd(), label: statement.name.text });
    continue;
  }

  if (ts.isTypeAliasDeclaration(statement) && statement.name.text === "ActiveCloudUpload") {
    foundActiveCloudUpload = true;
    ranges.push({ start: statement.getFullStart(), end: statement.getEnd(), label: "ActiveCloudUpload" });
    continue;
  }

  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations
      .map(declaration => ts.isIdentifier(declaration.name) ? declaration.name.text : null)
      .filter(Boolean);
    const matched = names.filter(name => requiredConstants.has(name));
    if (matched.length > 0) {
      if (matched.length !== names.length) {
        throw new Error(`storage key declaration unexpectedly shares a statement: ${names.join(", ")}`);
      }
      for (const name of matched) foundConstants.add(name);
      ranges.push({ start: statement.getFullStart(), end: statement.getEnd(), label: `storage key ${matched.join(",")}` });
    }
  }
}

for (const name of functionNames) {
  if (!foundFunctions.has(name)) throw new Error(`2.3 helper declaration not found: ${name}`);
}
if (!foundActiveCloudUpload) throw new Error("ActiveCloudUpload declaration not found");
for (const name of requiredConstants) {
  if (!foundConstants.has(name)) throw new Error(`storage key declaration not found: ${name}`);
}

const ordered = ranges.sort((a, b) => a.start - b.start);
const merged = [];
for (const range of ordered) {
  const previous = merged[merged.length - 1];
  if (previous && range.start <= previous.end) {
    previous.end = Math.max(previous.end, range.end);
    previous.label += `+${range.label}`;
  } else {
    merged.push({ ...range });
  }
}
for (const range of merged.sort((a, b) => b.start - a.start)) {
  app = app.slice(0, range.start) + app.slice(range.end);
}

once(
  'try { localStorage.removeItem(LIBRARY_CACHE_KEY); } catch {}',
  "clearCachedBeats();",
  "manual reload presentation cache clear"
);

for (const forbidden of [
  "function fileNameFromPath(",
  "function extensionFromPath(",
  "function isBackupFolderPath(",
  "function readActiveCloudUploads(",
  "function writeActiveCloudUploads(",
  "function markCloudUploadActive(",
  "function clearCloudUploadActive(",
  "function loadCachedBeats(",
  "function saveCachedBeats(",
  "function cloudBeatFingerprint(",
  "function drawerMetadataCommitFingerprint(",
  "function libraryViewFingerprint(",
  "function loadCachedSort(",
  "function saveCachedSort(",
  "function preserveLoadedArtwork(",
  "function clearUploadPreviewCache(",
  "function decodeArtworkDataUrl(",
  "LIBRARY_CACHE_KEY =",
  "SORT_CACHE_KEY =",
  "INTERRUPTED_UPLOADS_KEY =",
]) {
  if (app.includes(forbidden)) throw new Error(`local 2.3 ownership remains in App: ${forbidden}`);
}

// Preserve recent Desktop repairs and the existing Web/Desktop split verbatim.
for (const required of [
  'if (authoritativeBeatIds === null)',
  'if (!platform.capabilities.playbackCache || !cloudSessionVerified || connectionState !== "online") return;',
  'Math.min(isTauriAvailable ? 6 : 1, queue.length)',
  'if (!isTauriAvailable)',
  'const prepared = await platform.media.preparePlayback(beat)',
  'const ready = await prepareBeatForPlayback(beat)',
  'await libraryStateManager.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`)',
  'clearCloudUploadActive(original.id)',
  'const playbackReady = await waitForUploadedBeatPlaybackReady(detached)',
]) {
  if (!app.includes(required)) throw new Error(`protected Desktop/Web contract changed: ${required}`);
}
const uploadCommit = app.indexOf('await libraryStateManager.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`)');
const markerClear = app.indexOf('clearCloudUploadActive(original.id)', uploadCommit);
const playbackWarm = app.indexOf('const playbackReady = await waitForUploadedBeatPlaybackReady(detached)', markerClear);
if (!(uploadCommit >= 0 && markerClear > uploadCommit && playbackWarm > markerClear)) {
  throw new Error("Desktop per-beat durability/marker/playback order changed");
}

const characterizationPath = "tests/integration/appMigrationCharacterization.test.ts";
let characterization = readFileSync(characterizationPath, "utf8");
const oldRecoverySection = 'const recovery = section("async function rollbackInterruptedCloudUploads", "function loadCachedBeats");';
const newRecoverySection = 'const recovery = section("async function rollbackInterruptedCloudUploads", "function BeatGalerApp");';
const recoveryCount = characterization.split(oldRecoverySection).length - 1;
if (recoveryCount !== 1) {
  throw new Error(`App migration recovery characterization: expected exactly 1 old boundary, found ${recoveryCount}`);
}
characterization = characterization.replace(oldRecoverySection, newRecoverySection);

const regressionsPath = "scripts/run-regressions.mjs";
let regressions = readFileSync(regressionsPath, "utf8");
const appReadAnchor = '  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");';
const journalReadAnchor = `${appReadAnchor}\n  const interruptedUploadJournal = readFileSync(path.join(root, "src", "features", "cloud", "interruptedUploadJournal.ts"), "utf8");`;
const appReadCount = regressions.split(appReadAnchor).length - 1;
if (appReadCount !== 1) throw new Error(`regression App source read: expected 1 anchor, found ${appReadCount}`);
regressions = regressions.replace(appReadAnchor, journalReadAnchor);
const oldMarkerGuard = '  if (!app.includes("const INTERRUPTED_UPLOADS_KEY")) fail("Interrupted upload recovery marker disappeared.");';
const newMarkerGuard = '  if (!interruptedUploadJournal.includes(\'const INTERRUPTED_UPLOADS_KEY = "beatgaler:active-cloud-uploads:v1"\')) fail("Interrupted upload recovery marker disappeared or changed storage key.");';
const markerGuardCount = regressions.split(oldMarkerGuard).length - 1;
if (markerGuardCount !== 1) throw new Error(`Phase 11 marker regression: expected 1 old guard, found ${markerGuardCount}`);
regressions = regressions.replace(oldMarkerGuard, newMarkerGuard);

writeFileSync(appPath, app);
writeFileSync(characterizationPath, characterization);
writeFileSync(regressionsPath, regressions);
