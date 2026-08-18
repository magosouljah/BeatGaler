import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8");
const fail = message => { throw new Error(`Import/native-drop regression: ${message}`); };

const app = read("src/App.tsx");
const htmlController = read("src/features/dragdrop/htmlDropController.ts");
const tauriConfig = read("src-tauri/tauri.conf.json");
const commands = read("src-tauri/src/commands.rs");

if (!tauriConfig.includes('"dragDropEnabled": true')) fail("Tauri native dragDropEnabled must remain enabled.");
if (!app.includes("getCurrentWebview().onDragDropEvent")) fail("Windows Explorer drops must continue through Tauri onDragDropEvent.");
if (!app.includes("TAURI_NATIVE_DROP") || !app.includes("WINDOWS_NATIVE_LIBRARY_IMPORT_START")) fail("native filesystem drop diagnostics disappeared.");
if (!app.includes("await importDroppedPaths(payload.paths)")) fail("native library drop no longer enters the normal import stream with original filesystem paths.");
if (!app.includes("startImportReviewStream(normalized)")) fail("native import no longer starts the incremental Review stream.");
if (!app.includes("No\n      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy.")) fail("zero-copy native import invariant comment disappeared; review this path before release.");

const fallbackStart = app.indexOf("Non-Windows/browser fallback only.");
const fallbackGuard = app.indexOf("const windowsNativeDrop = isTauriAvailable && /Windows/i.test(navigator.userAgent);", fallbackStart);
const fallbackReturn = app.indexOf("if (windowsNativeDrop) return;", fallbackGuard);
if (fallbackStart < 0 || fallbackGuard < 0 || fallbackReturn < 0) fail("Windows is no longer excluded from the HTML DataTransfer fallback.");

const nativeStart = app.indexOf("const handleNativeDrop = async");
const nativeEnd = app.indexOf("    void (async () => {", nativeStart);
const nativeBlock = app.slice(nativeStart, nativeEnd > nativeStart ? nativeEnd : undefined);
if (nativeStart < 0) fail("handleNativeDrop disappeared.");
const nativeCodeOnly = nativeBlock
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
if (nativeCodeOnly.includes("stageCapturedHtmlDrop")) fail("native filesystem drop reintroduced HTML staging.");
if (nativeCodeOnly.includes(".arrayBuffer(")) fail("native filesystem drop reintroduced full File byte reads.");
if (!nativeBlock.includes("if (cardBeatId)")) fail("drop-on-existing-beat routing disappeared.");
if (!nativeBlock.includes("if (!library) return;")) fail("native filesystem drops can import outside the library target again.");
const signalIndex = app.indexOf("nativeExternalImageSignalFromPaths(incomingPaths)", nativeEnd);
const dispatchIndex = app.indexOf("void handleNativeDrop({ paths: incomingPaths", signalIndex);
if (signalIndex < 0 || dispatchIndex < 0 || signalIndex > dispatchIndex) fail("browser-image sentinels are no longer separated from filesystem paths before import.");

const stagingOccurrences = [...app.matchAll(/HTML_FALLBACK_STAGING_START/g)].length;
if (stagingOccurrences !== 0) fail("HTML_FALLBACK_STAGING_START must never live in App.tsx/native Windows routing.");
if (!htmlController.includes("HTML_FALLBACK_STAGING_START")) fail("browser/non-Windows fallback lost its staging diagnostic.");
if (!htmlController.includes("stageCapturedHtmlDrop(capturedDrop)")) fail("browser/non-Windows fallback lost staging itself.");

for (const name of ["samples", "stems", "backup", "backups", "audio"]) {
  if (!commands.toLowerCase().includes(`\"${name}\"`)) fail(`import discovery no longer documents/excludes auxiliary directory: ${name}`);
}
if (!commands.includes("Do not descend into Samples/Stems/Backup trees")) fail("recursive import auxiliary-directory invariant disappeared.");
if (!commands.includes("A standalone file is ONE slot. Never scan its parent folder")) fail("loose-file single-slot invariant disappeared.");
if (!commands.includes("discover_import_sources_recursive")) fail("deterministic recursive import discovery disappeared.");

console.log("PASS Phase 9B native import contracts: Windows keeps original filesystem paths, skips HTML staging, separates artwork/card/library targets, and preserves browser fallback isolation");
