from pathlib import Path
import re
import textwrap


def read(path):
    return Path(path).read_text(encoding="utf-8").replace("\r\n", "\n")


def write(path, content):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected once, found {count}")
    return text.replace(old, new, 1)


def sub_once(text, pattern, replacement, label):
    result, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected once, found {count}")
    return result


app = read("src/App.tsx")
app = replace_once(
    app,
    'import { extensionFromPath, fileNameFromPath, isBackupFolderPath } from "./features/dragdrop/pathHelpers";',
    'import { extensionFromPath, fileNameFromPath, isBackupFolderPath } from "./features/dragdrop/pathHelpers";\nimport { isNativeImagePath, resolveNativeExternalImageDropTarget, resolveNativeFilesystemDropTarget } from "./features/dragdrop/nativeDropTargets";',
    "native target import",
)

app = sub_once(
    app,
    r'''\n    const elementAtNativePosition = \(position: \{ x\?: number; y\?: number \} \| null \| undefined\): HTMLElement \| null => \{\n.*?\n    \};\n\n    const isImagePath = \(path: string\) => \{\n.*?\n    \};\n''',
    "\n",
    "inline native target helpers",
)

app = sub_once(
    app,
    r'''      const target = elementAtNativePosition\(position\);\n      const artwork = .*?\n      const drawerArtwork = .*?\n      const artworkBeatId = .*?\n''',
    '''      const destination = resolveNativeExternalImageDropTarget(position);\n      const artworkBeatId = destination.kind === "card-artwork" ? destination.beatId : null;\n      const drawerArtwork = destination.kind === "drawer-artwork";\n''',
    "external image hover target",
)

app = sub_once(
    app,
    r'''      const target = elementAtNativePosition\(payload\.position\);\n      const artwork = .*?\n      const card = .*?\n      const library = .*?\n      const drawerArtwork = .*?\n      const drawerFileRow = .*?\n      const drawerTarget = .*?\n      const localImage = .*?\n      const artworkBeatId = .*?\n      const cardBeatId = .*?\n''',
    '''      const routing = resolveNativeFilesystemDropTarget(payload.paths, payload.position);\n      const drawerTarget = routing.destination.kind === "drawer" ? routing.destination.target : null;\n      const artworkBeatId = routing.destination.kind === "card-artwork" ? routing.destination.beatId : null;\n      const cardBeatId = routing.destination.kind === "beat-card" ? routing.destination.beatId : null;\n''',
    "native hover routing",
)
app = replace_once(app, "      if (artworkBeatId && localImage) {", "      if (artworkBeatId) {", "hover artwork branch")
app = replace_once(app, "      setDropActive(Boolean(library && payload.paths.length > 0));", '      setDropActive(routing.destination.kind === "library");', "hover library branch")

app = sub_once(
    app,
    r'''      const target = elementAtNativePosition\(detail\);\n      const artwork = .*?\n      const drawerArtwork = .*?\n      const beatId = .*?\n''',
    '''      const destination = resolveNativeExternalImageDropTarget(detail);\n      const drawerArtwork = destination.kind === "drawer-artwork";\n      const beatId = destination.kind === "card-artwork" ? destination.beatId : null;\n''',
    "external image final target",
)

app = sub_once(
    app,
    r'''      const target = elementAtNativePosition\(payload\.position\);\n      const artwork = .*?\n      const card = .*?\n      const library = .*?\n      const drawerArtwork = .*?\n      const drawerFileRow = .*?\n      const drawerTarget = .*?\n      const artworkBeatId = .*?\n      const cardBeatId = .*?\n      clearNativeDragUi\(\);\n\n      reviewPerfMark\(`TAURI_NATIVE_DROP .*?\);\n''',
    '''      const routing = resolveNativeFilesystemDropTarget(payload.paths, payload.position);\n      const drawerTarget = routing.destination.kind === "drawer" ? routing.destination.target : null;\n      const artworkBeatId = routing.destination.kind === "card-artwork" ? routing.destination.beatId : null;\n      const cardBeatId = routing.destination.kind === "beat-card" ? routing.destination.beatId : null;\n      const library = routing.destination.kind === "library";\n      clearNativeDragUi();\n\n      reviewPerfMark(`TAURI_NATIVE_DROP path_count=${payload.paths.length} target=${routing.diagnosticTarget} names=${payload.paths.map(fileNameFromPath).slice(0, 12).join("|")}`);\n''',
    "native final routing",
)
app = replace_once(app, "        if (drawerTarget || artworkBeatId || cardBeatId || library) {", "        if (routing.hasAnyTarget) {", "empty path target guard")
app = replace_once(app, '        if (drawerTarget === "artwork" && !isImagePath(payload.paths[0])) {', '        if (drawerTarget === "artwork" && !isNativeImagePath(payload.paths[0])) {', "drawer artwork image guard")
app = replace_once(app, "      if (cardBeatId || library) claimNativeLibraryDrop();", "      if (routing.shouldClaimNativeLibraryDrop) claimNativeLibraryDrop();", "native claim guard")
app = replace_once(app, "      if (artworkBeatId && payload.paths.length === 1 && isImagePath(payload.paths[0])) {", "      if (artworkBeatId) {", "native artwork branch")

if "const elementAtNativePosition =" in app or "const isImagePath =" in app:
    raise RuntimeError("App.tsx still owns native target detection")
write("src/App.tsx", app)

module = r'''import { extensionFromPath } from "./pathHelpers";

export type NativeDropPosition = { x?: number; y?: number } | null | undefined;

export type NativeDropTargetEnvironment = {
  devicePixelRatio?: number;
  elementFromPoint?: (x: number, y: number) => Element | null;
};

export type NativeFilesystemDropDestination =
  | { kind: "drawer"; target: string }
  | { kind: "card-artwork"; beatId: string }
  | { kind: "beat-card"; beatId: string }
  | { kind: "library" }
  | { kind: "none" };

export type NativeFilesystemDropRouting = {
  destination: NativeFilesystemDropDestination;
  hasAnyTarget: boolean;
  shouldClaimNativeLibraryDrop: boolean;
  diagnosticTarget: string;
};

export type NativeExternalImageDropDestination =
  | { kind: "drawer-artwork" }
  | { kind: "card-artwork"; beatId: string }
  | { kind: "none" };

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif"]);

function elementAtNativePosition(
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
): HTMLElement | null {
  if (!position || typeof position.x !== "number" || typeof position.y !== "number") return null;
  const scale = (environment.devicePixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1)) || 1;
  const elementFromPoint = environment.elementFromPoint ?? ((x: number, y: number) => {
    if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;
    return document.elementFromPoint(x, y);
  });
  const candidates: Array<[number, number]> = [[position.x, position.y]];
  if (scale !== 1) candidates.push([position.x / scale, position.y / scale]);
  for (const [x, y] of candidates) {
    const element = elementFromPoint(x, y) as HTMLElement | null;
    if (element) return element;
  }
  return null;
}

function locateNativeDropTargets(
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
) {
  const target = elementAtNativePosition(position, environment);
  const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
  const card = target?.closest?.("[data-beat-card-id]") as HTMLElement | null;
  const library = target?.closest?.('[data-library-scroll="true"]') as HTMLElement | null;
  const drawerArtwork = target?.closest?.("[data-artwork-drop]") as HTMLElement | null;
  const drawerFileRow = target?.closest?.("[data-filerole]") as HTMLElement | null;
  return {
    artworkBeatId: artwork?.dataset.beatArtworkId ?? null,
    cardBeatId: card?.dataset.beatCardId ?? null,
    library: Boolean(library),
    drawerArtwork: Boolean(drawerArtwork),
    drawerTarget: drawerArtwork ? "artwork" : drawerFileRow?.dataset.filerole ?? null,
  };
}

export function isNativeImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionFromPath(path));
}

export function resolveNativeFilesystemDropTarget(
  paths: string[],
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
): NativeFilesystemDropRouting {
  const found = locateNativeDropTargets(position, environment);
  const localImage = paths.length === 1 && isNativeImagePath(paths[0]);
  let destination: NativeFilesystemDropDestination = { kind: "none" };
  if (found.drawerTarget) destination = { kind: "drawer", target: found.drawerTarget };
  else if (found.artworkBeatId && localImage) destination = { kind: "card-artwork", beatId: found.artworkBeatId };
  else if (paths.length > 0 && found.cardBeatId) destination = { kind: "beat-card", beatId: found.cardBeatId };
  else if (paths.length > 0 && found.library) destination = { kind: "library" };
  return {
    destination,
    hasAnyTarget: Boolean(found.drawerTarget || found.artworkBeatId || found.cardBeatId || found.library),
    shouldClaimNativeLibraryDrop: Boolean(found.cardBeatId || found.library),
    diagnosticTarget: found.drawerTarget ?? (found.artworkBeatId ? "card-artwork" : found.cardBeatId ? "beat-card" : found.library ? "library" : "none"),
  };
}

export function resolveNativeExternalImageDropTarget(
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
): NativeExternalImageDropDestination {
  const found = locateNativeDropTargets(position, environment);
  if (found.drawerArtwork) return { kind: "drawer-artwork" };
  if (found.artworkBeatId) return { kind: "card-artwork", beatId: found.artworkBeatId };
  return { kind: "none" };
}
'''
write("src/features/dragdrop/nativeDropTargets.ts", module)

test = r'''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isNativeImagePath,
  resolveNativeExternalImageDropTarget,
  resolveNativeFilesystemDropTarget,
} from "../../src/features/dragdrop/nativeDropTargets";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const targets = readFileSync(resolve(process.cwd(), "src/features/dragdrop/nativeDropTargets.ts"), "utf8");

describe("task 8.1 native drop target extraction", () => {
  it("moves coordinate, scale, data-* and image classification ownership out of App", () => {
    expect(app).toContain("resolveNativeFilesystemDropTarget(payload.paths, payload.position)");
    expect(app).toContain("resolveNativeExternalImageDropTarget(position)");
    expect(app).not.toContain("const elementAtNativePosition =");
    expect(app).not.toContain("const isImagePath =");
    for (const marker of ["window.devicePixelRatio", "document.elementFromPoint", "[data-beat-artwork-id]", "[data-beat-card-id]", "[data-library-scroll=\\\"true\\\"]", "[data-artwork-drop]", "[data-filerole]"]) expect(targets).toContain(marker);
  });

  it("tries native coordinates first and scaled coordinates second", () => {
    const card = document.createElement("div"); card.dataset.beatCardId = "b1";
    const artwork = document.createElement("div"); artwork.dataset.beatArtworkId = "b1"; card.append(artwork);
    const calls: Array<[number, number]> = [];
    const routing = resolveNativeFilesystemDropTarget(["beat.wav"], { x: 200, y: 100 }, {
      devicePixelRatio: 2,
      elementFromPoint: (x, y) => { calls.push([x, y]); return calls.length === 1 ? null : artwork; },
    });
    expect(calls).toEqual([[200, 100], [100, 50]]);
    expect(routing.destination).toEqual({ kind: "beat-card", beatId: "b1" });
    expect(routing.shouldClaimNativeLibraryDrop).toBe(true);
  });

  it("preserves Drawer > image artwork > card > library priority", () => {
    const card = document.createElement("div"); card.dataset.beatCardId = "b2";
    const artwork = document.createElement("div"); artwork.dataset.beatArtworkId = "b2"; card.append(artwork);
    expect(resolveNativeFilesystemDropTarget(["cover.PNG"], { x: 1, y: 1 }, { elementFromPoint: () => artwork }).destination).toEqual({ kind: "card-artwork", beatId: "b2" });
    expect(resolveNativeFilesystemDropTarget(["master.wav"], { x: 1, y: 1 }, { elementFromPoint: () => artwork }).destination).toEqual({ kind: "beat-card", beatId: "b2" });
    const drawer = document.createElement("div"); drawer.dataset.filerole = "wav"; card.append(drawer);
    expect(resolveNativeFilesystemDropTarget(["cover.png"], { x: 1, y: 1 }, { elementFromPoint: () => drawer }).destination).toEqual({ kind: "drawer", target: "wav" });
    const library = document.createElement("div"); library.dataset.libraryScroll = "true";
    const child = document.createElement("span"); library.append(child);
    expect(resolveNativeFilesystemDropTarget(["beat.wav"], { x: 1, y: 1 }, { elementFromPoint: () => child }).destination).toEqual({ kind: "library" });
  });

  it("keeps browser/Pinterest images artwork-only with Drawer artwork priority", () => {
    const artwork = document.createElement("div"); artwork.dataset.beatArtworkId = "b3";
    expect(resolveNativeExternalImageDropTarget({ x: 1, y: 1 }, { elementFromPoint: () => artwork })).toEqual({ kind: "card-artwork", beatId: "b3" });
    const drawerArtwork = document.createElement("div"); drawerArtwork.dataset.artworkDrop = "true"; artwork.append(drawerArtwork);
    expect(resolveNativeExternalImageDropTarget({ x: 1, y: 1 }, { elementFromPoint: () => drawerArtwork })).toEqual({ kind: "drawer-artwork" });
  });

  it("preserves the native artwork extension set", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif"]) expect(isNativeImagePath(`x.${ext}`)).toBe(true);
    expect(isNativeImagePath("x.wav")).toBe(false);
  });
});
'''
write("tests/integration/appNativeDropTargetsExtraction.test.ts", test)

reg = read("scripts/regression-import-native.mjs")
reg = replace_once(reg, 'const htmlController = read("src/features/dragdrop/htmlDropController.ts");', 'const htmlController = read("src/features/dragdrop/htmlDropController.ts");\nconst nativeTargets = read("src/features/dragdrop/nativeDropTargets.ts");', "native regression owner read")
reg = replace_once(reg,
    'if (!app.includes("TAURI_NATIVE_DROP") || !app.includes("NATIVE_LIBRARY_IMPORT_START")) fail("native filesystem drop diagnostics disappeared.");',
    'if (!app.includes("TAURI_NATIVE_DROP") || !app.includes("NATIVE_LIBRARY_IMPORT_START")) fail("native filesystem drop diagnostics disappeared.");\nif (!app.includes("resolveNativeFilesystemDropTarget(payload.paths, payload.position)")) fail("native drop target routing is no longer wired through its extracted owner.");\nif (app.includes("const elementAtNativePosition =") || app.includes("const isImagePath =")) fail("native target detection leaked back into App.tsx.");\nif (!nativeTargets.includes("document.elementFromPoint") || !nativeTargets.includes("window.devicePixelRatio") || !nativeTargets.includes("[data-filerole]")) fail("native target owner lost coordinate/scale/Drawer classification.");',
    "native regression owner guard")
write("scripts/regression-import-native.mjs", reg)

mac = read("scripts/test-macos-portability.mjs")
mac = replace_once(mac, 'const htmlDrop = read("src/features/dragdrop/htmlDropController.ts");', 'const htmlDrop = read("src/features/dragdrop/htmlDropController.ts");\nconst nativeDropTargets = read("src/features/dragdrop/nativeDropTargets.ts");', "mac owner read")
mac = replace_once(mac,
    'ok(app.includes(\'if (artworkBeatId && payload.paths.length === 1 && isImagePath(payload.paths[0]))\') && app.includes("nativeExternalImageSignalFromPaths"), "Mac routes Finder artwork through native paths while preserving browser/Pinterest sentinels");',
    'ok(app.includes("resolveNativeFilesystemDropTarget(payload.paths, payload.position)") && nativeDropTargets.includes("isNativeImagePath") && nativeDropTargets.includes("window.devicePixelRatio") && nativeDropTargets.includes("[data-beat-artwork-id]") && app.includes("nativeExternalImageSignalFromPaths"), "Mac routes Finder artwork through extracted native target detection while preserving browser/Pinterest sentinels");',
    "mac routing guard")
write("scripts/test-macos-portability.mjs", mac)
