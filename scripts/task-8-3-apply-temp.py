from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8").replace("\r\n", "\n")

def write(rel, text):
    (ROOT / rel).parent.mkdir(parents=True, exist_ok=True)
    (ROOT / rel).write_text(text, encoding="utf-8", newline="\n")

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

app_path = "src/App.tsx"
app = read(app_path)

effect_start_marker = '  useEffect(() => {\n    if (!isTauriAvailable) return;\n'
effect_end_marker = '\n  const reloadLibrary = useCallback'
effect_start = app.find(effect_start_marker)
effect_end = app.find(effect_end_marker, effect_start)
if effect_start < 0 or effect_end < 0:
    raise SystemExit("Could not locate the native drag/drop effect in App.tsx")
native_effect = app[effect_start:effect_end]
native_effect = replace_once(
    native_effect,
    '    if (!isTauriAvailable) return;',
    '    if (!nativeDropAvailable) return;',
    "native availability gate",
)
native_effect = native_effect.replace("REVIEW_SKELETON_ENABLED", "reviewSkeletonEnabled")

owner = '''import { useEffect } from "react";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { diagnosticLog, isDirectoryPath, readImagePathAsDataUrl } from "../../lib/tauri";
import { fetchInternetArtworkDataUrl } from "../artwork/internetArtwork";
import { reviewPerfMark } from "../perf/reviewPerf";
import { nativeExternalImageSignalFromPaths } from "./nativeExternalImage";
import { claimNativeLibraryDrop } from "./nativeDropArbiter";
import { fileNameFromPath, isBackupFolderPath } from "./pathHelpers";
import { isNativeImagePath, resolveNativeExternalImageDropTarget, resolveNativeFilesystemDropTarget } from "./nativeDropTargets";

const MAX_NATIVE_DROP_ITEMS = 50;

type NativeBeatFileDrop = {
  beat: Beat;
  filePath: string;
  kind: "file" | "directory";
};

type UseNativeLibraryDropOptions = {
  nativeDropAvailable: boolean;
  reviewSkeletonEnabled: boolean;
  beatsLatestRef: { current: Beat[] };
  setDropActive: (active: boolean) => void;
  setBeatCloudUpdateBusy: (beatId: string, active: boolean, success?: boolean) => void;
  setBeatFileDrop: (value: NativeBeatFileDrop | null) => void;
  setLibraryDropStaging: (active: boolean) => void;
  handleDropArtwork: (beat: Beat, imageBase64: string) => void | Promise<void>;
  handleAutoProjectDrop: (
    beat: Beat,
    filePath: string,
  ) => "not-project" | "handled" | "started" | Promise<"not-project" | "handled" | "started">;
  importDroppedPaths: (paths: string[]) => void | Promise<void>;
};

export function useNativeLibraryDrop({
  nativeDropAvailable,
  reviewSkeletonEnabled,
  beatsLatestRef,
  setDropActive,
  setBeatCloudUpdateBusy,
  setBeatFileDrop,
  setLibraryDropStaging,
  handleDropArtwork,
  handleAutoProjectDrop,
  importDroppedPaths,
}: UseNativeLibraryDropOptions): void {
''' + native_effect + '''
}
'''
write("src/features/dragdrop/useNativeLibraryDrop.ts", owner)

app = replace_once(
    app,
    ', prepareUniqueExportFolder, readImagePathAsDataUrl, isDirectoryPath, diagnosticLog, type CloudFileType, isTauriAvailable',
    ', prepareUniqueExportFolder, type CloudFileType, isTauriAvailable',
    "tauri native drop imports",
)
for line, label in [
    ('import { fetchInternetArtworkDataUrl } from "./features/artwork/internetArtwork";\n', "internet artwork import"),
    ('import { nativeExternalImageSignalFromPaths } from "./features/dragdrop/nativeExternalImage";\n', "native external image import"),
    ('import { claimNativeLibraryDrop } from "./features/dragdrop/nativeDropArbiter";\n', "native arbiter import"),
    ('import { isNativeImagePath, resolveNativeExternalImageDropTarget, resolveNativeFilesystemDropTarget } from "./features/dragdrop/nativeDropTargets";\n', "native targets import"),
    ('import { reviewPerfMark } from "./features/perf/reviewPerf";\n', "review perf import"),
]:
    app = replace_once(app, line, "", label)

app = replace_once(
    app,
    'import { extensionFromPath, fileNameFromPath, isBackupFolderPath } from "./features/dragdrop/pathHelpers";',
    'import { extensionFromPath, fileNameFromPath } from "./features/dragdrop/pathHelpers";',
    "path helper imports",
)
app = replace_once(
    app,
    'import { useHtmlLibraryDrop } from "./features/dragdrop/useHtmlLibraryDrop";',
    'import { useHtmlLibraryDrop } from "./features/dragdrop/useHtmlLibraryDrop";\nimport { useNativeLibraryDrop } from "./features/dragdrop/useNativeLibraryDrop";',
    "native hook import",
)
app = replace_once(
    app,
    '// Safety cap for one Explorer drag gesture. A parent folder still counts as one\n'
    '// root and is discovered lazily, so this never forces a full-tree scan.\n'
    'const MAX_NATIVE_DROP_ITEMS = 50;\n',
    '',
    "native safety cap",
)

composition = '''  useNativeLibraryDrop({
    nativeDropAvailable: isTauriAvailable,
    reviewSkeletonEnabled: REVIEW_SKELETON_ENABLED,
    beatsLatestRef,
    setDropActive,
    setBeatCloudUpdateBusy,
    setBeatFileDrop,
    setLibraryDropStaging,
    handleDropArtwork,
    handleAutoProjectDrop,
    importDroppedPaths,
  });
'''
app = app[:effect_start] + composition + app[effect_end:]
write(app_path, app)

write("tests/integration/appNativeLibraryDropExtraction.test.ts", '''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const app = read("src/App.tsx");
const owner = read("src/features/dragdrop/useNativeLibraryDrop.ts");
const targets = read("src/features/dragdrop/nativeDropTargets.ts");
const arbiter = read("src/features/dragdrop/nativeDropArbiter.ts");

describe("task 8.3 native drop extraction", () => {
  it("moves Tauri listener ownership out of App while keeping one composition point", () => {
    expect(app).toContain("useNativeLibraryDrop({");
    expect((app.match(/useNativeLibraryDrop\\(\\{/g) ?? []).length).toBe(1);
    expect(app).not.toContain("getCurrentWebview().onDragDropEvent");
    expect(app).not.toContain("const handleNativeDrop = async");
    expect(owner).toContain("getCurrentWebview().onDragDropEvent");
    expect((owner.match(/onDragDropEvent\\(/g) ?? []).length).toBe(1);
    expect(owner).toContain("if (!nativeDropAvailable) return;");
  });

  it("preserves native routing, safety limit, original paths and zero-copy import", () => {
    expect(owner).toContain("const MAX_NATIVE_DROP_ITEMS = 50;");
    expect(owner).toContain("resolveNativeFilesystemDropTarget(payload.paths, payload.position)");
    expect(owner).toContain("if (payload.paths.length > MAX_NATIVE_DROP_ITEMS)");
    expect(owner).toContain("await importDroppedPaths(payload.paths)");
    expect(owner).toContain("No\\n      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy.");
    expect(owner).not.toContain("stageCapturedHtmlDrop");
    expect(owner).not.toContain(".arrayBuffer(");
    expect(targets).toContain("window.devicePixelRatio");
    expect(targets).toContain("[data-filerole]");
  });

  it("keeps Finder/Explorer arbitration and browser-image sentinels ahead of local import", () => {
    const signal = owner.indexOf("nativeExternalImageSignalFromPaths(incomingPaths)");
    const localImport = owner.indexOf("void handleNativeDrop({ paths: incomingPaths", signal);
    expect(signal).toBeGreaterThan(-1);
    expect(localImport).toBeGreaterThan(signal);
    expect(owner).toContain("claimNativeLibraryDrop()");
    expect(arbiter).toContain("waitForNativeLibraryDropClaim");
    expect(owner).toContain("URLs never enter Import Beat and are accepted only by an artwork target");
  });

  it("cleans up listener registration even when async registration resolves after unmount", () => {
    expect(owner).toContain("if (cancelled) stop();");
    expect(owner).toContain("else unlisten = stop;");
    expect(owner).toContain("cancelled = true;");
    expect(owner).toContain("unlisten?.();");
    expect(owner).toContain('window.removeEventListener("native-external-image-drop", onNativeExternalImageDrop);');
    expect(owner).toContain("clearNativeDragUi();");
  });
});
''')

path = "scripts/regression-import-native.mjs"
text = read(path)
text = replace_once(
    text,
    'const htmlDropOwner = read("src/features/dragdrop/useHtmlLibraryDrop.ts");\n',
    'const htmlDropOwner = read("src/features/dragdrop/useHtmlLibraryDrop.ts");\n'
    'const nativeDropOwner = read("src/features/dragdrop/useNativeLibraryDrop.ts");\n',
    "native regression owner read",
)
replacements = [
    ('if (!app.includes("getCurrentWebview().onDragDropEvent"))', 'if (!nativeDropOwner.includes("getCurrentWebview().onDragDropEvent"))'),
    ('if (!app.includes("TAURI_NATIVE_DROP") || !app.includes("NATIVE_LIBRARY_IMPORT_START"))', 'if (!nativeDropOwner.includes("TAURI_NATIVE_DROP") || !nativeDropOwner.includes("NATIVE_LIBRARY_IMPORT_START"))'),
    ('if (!app.includes("resolveNativeFilesystemDropTarget(payload.paths, payload.position)"))', 'if (!nativeDropOwner.includes("resolveNativeFilesystemDropTarget(payload.paths, payload.position)"))'),
    ('if (app.includes("const elementAtNativePosition =") || app.includes("const isImagePath ="))', 'if ([app, nativeDropOwner].some(source => source.includes("const elementAtNativePosition =") || source.includes("const isImagePath =")))'),
    ('if (!app.includes("await importDroppedPaths(payload.paths)"))', 'if (!nativeDropOwner.includes("await importDroppedPaths(payload.paths)"))'),
    ('if (!app.includes("No\\n      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy."))', 'if (!nativeDropOwner.includes("No\\n      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy."))'),
    ('const nativeStart = app.indexOf("const handleNativeDrop = async");', 'const nativeStart = nativeDropOwner.indexOf("const handleNativeDrop = async");'),
    ('const nativeEnd = app.indexOf("    void (async () => {", nativeStart);', 'const nativeEnd = nativeDropOwner.indexOf("    void (async () => {", nativeStart);'),
    ('const nativeBlock = app.slice(nativeStart, nativeEnd > nativeStart ? nativeEnd : undefined);', 'const nativeBlock = nativeDropOwner.slice(nativeStart, nativeEnd > nativeStart ? nativeEnd : undefined);'),
    ('const signalIndex = app.indexOf("nativeExternalImageSignalFromPaths(incomingPaths)", nativeEnd);', 'const signalIndex = nativeDropOwner.indexOf("nativeExternalImageSignalFromPaths(incomingPaths)", nativeEnd);'),
    ('const dispatchIndex = app.indexOf("void handleNativeDrop({ paths: incomingPaths", signalIndex);', 'const dispatchIndex = nativeDropOwner.indexOf("void handleNativeDrop({ paths: incomingPaths", signalIndex);'),
    ('const stagingOccurrences = [...app.matchAll(/HTML_FALLBACK_STAGING_START/g)].length;', 'const stagingOccurrences = [app, nativeDropOwner].reduce((count, source) => count + [...source.matchAll(/HTML_FALLBACK_STAGING_START/g)].length, 0);'),
]
for old, new in replacements:
    text = replace_once(text, old, new, f"regression-import-native replacement: {old[:36]}")
text = replace_once(
    text,
    'if (!app.includes("useHtmlLibraryDrop({")) fail("App no longer composes the extracted HTML drop owner.");\n',
    'if (!app.includes("useHtmlLibraryDrop({")) fail("App no longer composes the extracted HTML drop owner.");\n'
    'if (!app.includes("useNativeLibraryDrop({")) fail("App no longer composes the extracted native drop owner.");\n'
    'if (app.includes("getCurrentWebview().onDragDropEvent") || app.includes("const handleNativeDrop = async")) fail("native listener ownership leaked back into App.tsx.");\n',
    "native composition regression",
)
write(path, text)

path = "scripts/run-regressions.mjs"
text = read(path)
text = replace_once(
    text,
    '  const htmlDropOwner = readFileSync(path.join(root, "src", "features", "dragdrop", "useHtmlLibraryDrop.ts"), "utf8");\n',
    '  const htmlDropOwner = readFileSync(path.join(root, "src", "features", "dragdrop", "useHtmlLibraryDrop.ts"), "utf8");\n'
    '  const nativeDropOwner = readFileSync(path.join(root, "src", "features", "dragdrop", "useNativeLibraryDrop.ts"), "utf8");\n',
    "broad regression owner read",
)
replacements = [
    ('if (!app.includes("getCurrentWebview().onDragDropEvent"))', 'if (!nativeDropOwner.includes("getCurrentWebview().onDragDropEvent"))'),
    ('if (!app.includes("TAURI_NATIVE_DROP") || !app.includes("NATIVE_LIBRARY_IMPORT_START"))', 'if (!nativeDropOwner.includes("TAURI_NATIVE_DROP") || !nativeDropOwner.includes("NATIVE_LIBRARY_IMPORT_START"))'),
    ('if (!app.includes("MAX_NATIVE_DROP_ITEMS = 50"))', 'if (!nativeDropOwner.includes("MAX_NATIVE_DROP_ITEMS = 50"))'),
    ('if (!app.includes("readImagePathAsDataUrl"))', 'if (!nativeDropOwner.includes("readImagePathAsDataUrl"))'),
    ('if (!app.includes(\'window.dispatchEvent(new CustomEvent("native-external-image-drop"\'))', 'if (!nativeDropOwner.includes(\'window.dispatchEvent(new CustomEvent("native-external-image-drop"\'))'),
    ('if (!app.includes(\'window.addEventListener("native-external-image-drop"\'))', 'if (!nativeDropOwner.includes(\'window.addEventListener("native-external-image-drop"\'))'),
    ('if (!app.includes("nativeExternalImageSignalFromPaths(incomingPaths)"))', 'if (!nativeDropOwner.includes("nativeExternalImageSignalFromPaths(incomingPaths)"))'),
    ('if (!app.includes("URLs never enter Import Beat and are accepted only by an artwork target"))', 'if (!nativeDropOwner.includes("URLs never enter Import Beat and are accepted only by an artwork target"))'),
    ('const nativeDropEffectStart = app.indexOf("    const handleNativeDrop = async");', 'const nativeDropEffectStart = nativeDropOwner.indexOf("    const handleNativeDrop = async");'),
    ('const nativeDropEffectEnd = app.indexOf("  const handleCloudFiles =", nativeDropEffectStart);', 'const nativeDropEffectEnd = nativeDropOwner.indexOf("    void (async () => {", nativeDropEffectStart);'),
    ('const nativeDropEffect = app.slice(nativeDropEffectStart, nativeDropEffectEnd);', 'const nativeDropEffect = nativeDropOwner;'),
]
for old, new in replacements:
    text = replace_once(text, old, new, f"run-regressions replacement: {old[:36]}")
text = replace_once(
    text,
    '  if (!app.includes("useHtmlLibraryDrop({")) fail("App no longer composes the extracted HTML/browser drop owner.");\n',
    '  if (!app.includes("useHtmlLibraryDrop({")) fail("App no longer composes the extracted HTML/browser drop owner.");\n'
    '  if (!app.includes("useNativeLibraryDrop({")) fail("App no longer composes the extracted native drop owner.");\n'
    '  if (app.includes("getCurrentWebview().onDragDropEvent") || app.includes("const handleNativeDrop = async")) fail("Native listener ownership leaked back into App.tsx.");\n',
    "broad native composition guard",
)
write(path, text)

path = "scripts/test-macos-portability.mjs"
text = read(path)
text = replace_once(
    text,
    'const nativeDropTargets = read("src/features/dragdrop/nativeDropTargets.ts");\n',
    'const nativeDropTargets = read("src/features/dragdrop/nativeDropTargets.ts");\n'
    'const nativeDropOwner = read("src/features/dragdrop/useNativeLibraryDrop.ts");\n',
    "mac owner read",
)
replacements = [
    ('ok(app.includes("getCurrentWebview().onDragDropEvent"), "Tauri native filesystem drop listener is installed");',
     'ok(nativeDropOwner.includes("getCurrentWebview().onDragDropEvent") && app.includes("useNativeLibraryDrop({"), "Tauri native filesystem drop listener is installed");'),
    ('ok(app.includes("if (!isTauriAvailable) return;"), "native drop listener is not gated to Windows only");',
     'ok(nativeDropOwner.includes("if (!nativeDropAvailable) return;"), "native drop listener is not gated to Windows only");'),
    ('ok(app.includes("claimNativeLibraryDrop()") && htmlDrop.includes("waitForNativeLibraryDropClaim"), "Mac duplicate native/HTML local drops are arbitrated");',
     'ok(nativeDropOwner.includes("claimNativeLibraryDrop()") && htmlDrop.includes("waitForNativeLibraryDropClaim"), "Mac duplicate native/HTML local drops are arbitrated");'),
    ('ok(app.includes("resolveNativeFilesystemDropTarget(payload.paths, payload.position)") && nativeDropTargets.includes("isNativeImagePath") && nativeDropTargets.includes("window.devicePixelRatio") && nativeDropTargets.includes("[data-beat-artwork-id]") && app.includes("nativeExternalImageSignalFromPaths"), "Mac routes Finder artwork through extracted native target detection while preserving browser/Pinterest sentinels");',
     'ok(nativeDropOwner.includes("resolveNativeFilesystemDropTarget(payload.paths, payload.position)") && nativeDropTargets.includes("isNativeImagePath") && nativeDropTargets.includes("window.devicePixelRatio") && nativeDropTargets.includes("[data-beat-artwork-id]") && nativeDropOwner.includes("nativeExternalImageSignalFromPaths"), "Mac routes Finder artwork through extracted native target detection while preserving browser/Pinterest sentinels");'),
]
for old, new in replacements:
    text = replace_once(text, old, new, f"mac portability replacement: {old[:36]}")
write(path, text)

print("Task 8.3 patch prepared.")
