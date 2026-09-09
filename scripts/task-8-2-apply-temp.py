from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


app_path = Path("src/App.tsx")
app = app_path.read_text(encoding="utf-8")

app = app.replace('import { artworkFileToDataUrl } from "./features/dragdrop/browserArtwork";\n', "")
app = app.replace('import { installHtmlDropController } from "./features/dragdrop/htmlDropController";\n', "")
native_import = 'import { isNativeImagePath, resolveNativeExternalImageDropTarget, resolveNativeFilesystemDropTarget } from "./features/dragdrop/nativeDropTargets";\n'
hook_import = 'import { useHtmlLibraryDrop } from "./features/dragdrop/useHtmlLibraryDrop";\n'
if hook_import not in app:
    require(native_import in app, "native target import anchor missing")
    app = app.replace(native_import, native_import + hook_import, 1)

start = app.find("  const handleBrowserBeatFileDrop = useCallback")
native_effect = app.find('  useEffect(() => {\n    if (!isTauriAvailable) return;', start)
require(start >= 0 and native_effect > start, "HTML drop ownership block anchors missing")

hook_call = '''  useHtmlLibraryDrop({
    nativeDropAvailable: isTauriAvailable,
    browserFileImport: platform.capabilities.browserFileImport,
    reviewSkeletonEnabled: REVIEW_SKELETON_ENABLED,
    beatsLatestRef,
    setDropActive,
    setBeatCloudUpdateBusy,
    setBeatFileDrop,
    setLibraryDropStaging,
    handleDropArtwork,
    handleAutoProjectDrop,
    handleBrowserBeatAssetDrop,
    handleBrowserProjectDrop,
    importDroppedBrowserFiles,
    importDroppedPaths,
  });

'''
app = app[:start] + hook_call + app[native_effect:]
app_path.write_text(app, encoding="utf-8")

hook = '''import { useCallback, useEffect } from "react";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { fetchInternetArtworkDataUrl } from "../artwork/internetArtwork";
import { artworkFileToDataUrl } from "./browserArtwork";
import { cleanupStagedDropPaths } from "./dropStaging";
import { installHtmlDropController } from "./htmlDropController";
import { isBackupFolderPath } from "./pathHelpers";

type HtmlBeatFileDrop = {
  beat: Beat;
  filePath: string;
  kind: "file" | "directory";
};

type UseHtmlLibraryDropOptions = {
  nativeDropAvailable: boolean;
  browserFileImport: boolean;
  reviewSkeletonEnabled: boolean;
  beatsLatestRef: { current: Beat[] };
  setDropActive: (active: boolean) => void;
  setBeatCloudUpdateBusy: (beatId: string, active: boolean, success?: boolean) => void;
  setBeatFileDrop: (value: HtmlBeatFileDrop | null) => void;
  setLibraryDropStaging: (active: boolean) => void;
  handleDropArtwork: (beat: Beat, imageBase64: string) => void | Promise<void>;
  handleAutoProjectDrop: (beat: Beat, filePath: string) => "not-project" | "handled" | "started" | Promise<"not-project" | "handled" | "started">;
  handleBrowserBeatAssetDrop: (beat: Beat, file: File, kind: "MASTER" | "WAV") => Promise<boolean>;
  handleBrowserProjectDrop: (beat: Beat, file: File) => Promise<boolean>;
  importDroppedBrowserFiles: (files: File[]) => void | Promise<void>;
  importDroppedPaths: (paths: string[]) => void | Promise<void>;
};

export function useHtmlLibraryDrop({
  nativeDropAvailable,
  browserFileImport,
  reviewSkeletonEnabled,
  beatsLatestRef,
  setDropActive,
  setBeatCloudUpdateBusy,
  setBeatFileDrop,
  setLibraryDropStaging,
  handleDropArtwork,
  handleAutoProjectDrop,
  handleBrowserBeatAssetDrop,
  handleBrowserProjectDrop,
  importDroppedBrowserFiles,
  importDroppedPaths,
}: UseHtmlLibraryDropOptions): void {
  const handleBrowserBeatFileDrop = useCallback(async (beatId: string, files: File[]): Promise<boolean> => {
    const beat = beatsLatestRef.current.find(item => item.id === beatId);
    if (!beat) throw new Error(`Dropped file target beat was not found: ${beatId}`);
    if (files.length !== 1) {
      await appAlert({ title: "Drop one file at a time", message: "Drop one MP3, WAV, or PROJECT ZIP on a beat." });
      return false;
    }

    const file = files[0];
    const name = file.name.toLowerCase();
    const kind = name.endsWith(".mp3") ? "MASTER" : name.endsWith(".wav") ? "WAV" : name.endsWith(".zip") ? "PROJECT" : null;
    if (!kind) {
      await appAlert({ title: "Unsupported file", message: "BeatGaler Web accepts MP3, WAV, or PROJECT ZIP files on an existing beat." });
      return false;
    }

    if (kind === "MASTER" || kind === "WAV") {
      return handleBrowserBeatAssetDrop(beat, file, kind);
    }

    return handleBrowserProjectDrop(beat, file);
  }, [beatsLatestRef, handleBrowserBeatAssetDrop, handleBrowserProjectDrop]);

  // Browser/Pinterest controller. Windows desktop keeps the existing single native
  // owner. macOS keeps HTML enabled for browser artwork while local Finder drops
  // are claimed by the native-path fast path before staging can begin.
  useEffect(() => {
    // On Windows desktop, WRY/Tauri owns the external drop. Explorer gives us
    // original paths with zero byte staging, while browser/Pinterest payloads
    // stay on that same native receiver. The HTML DataTransfer controller is
    // intentionally not installed there; otherwise the same local file drop
    // can fall back to File.arrayBuffer() and recreate the 20-40s staging delay.
    const windowsNativeDrop = nativeDropAvailable && /Windows/i.test(navigator.userAgent);
    if (windowsNativeDrop) return;

    return installHtmlDropController({
      setGlobalDropActive: setDropActive,
      onArtworkDrop: async (beatId, sources) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) throw new Error(`Dropped artwork target beat was not found: ${beatId}`);

        setBeatCloudUpdateBusy(beat.id, true);
        try {
          const conversionErrors: string[] = [];
          let imageData: string | null = null;

          // Browser drags are intentionally multi-source. Pinterest/Chromium may
          // provide a CDN URL AND a virtual File; whichever representation works
          // first wins. A failed cloud URL fetch therefore cannot kill a usable
          // virtual-file drop, and vice versa.
          for (const source of sources) {
            try {
              const candidate = source.kind === "remote"
                ? (/^data:image\\//i.test(source.url) ? source.url : await fetchInternetArtworkDataUrl(source.url))
                : await artworkFileToDataUrl(source.file);
              if (!/^data:image\\//i.test(candidate) || candidate.length < 32) {
                throw new Error("Artwork source returned an invalid/empty image payload.");
              }
              imageData = candidate;
              console.info(`[dragdrop/artwork] resolved via ${source.kind}`);
              break;
            } catch (error) {
              conversionErrors.push(`${source.kind}: ${String(error)}`);
              console.warn(`[dragdrop/artwork] ${source.kind} candidate failed; trying fallback`, error);
            }
          }

          if (!imageData) {
            throw new Error(`Pinterest/browser artwork could not be decoded. ${conversionErrors.join(" | ")}`);
          }

          await handleDropArtwork(beat, imageData);
        } finally {
          setBeatCloudUpdateBusy(beat.id, false);
        }
      },
      onBeatFileDrop: async (beatId, roots) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) return false;
        if (roots.length > 1) {
          await appAlert({
            title: "Drop one file at a time",
            message: "Drop a single file or folder on a beat so BeatGaler can assign it to the correct slot.",
          });
          return false;
        }
        const root = roots[0];
        if (isBackupFolderPath(root.path)) {
          await cleanupStagedDropPaths([root.path]).catch(() => {});
          await appAlert({
            title: "Backup folder skipped",
            message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
          });
          return false;
        }

        // Project files and PROJECT ZIPs have exactly one sensible destination,
        // so do not make the user answer a redundant "What are you adding?" page.
        // The card is already in its loading state while WebView2 stages/inspects
        // the drop, so large ZIPs never look like the app ignored them.
        const autoResult = await handleAutoProjectDrop(beat, root.path);
        if (autoResult === "started") return true;
        if (autoResult === "handled") return false;

        setBeatFileDrop({ beat, filePath: root.path, kind: root.kind });
        return false;
      },
      onBeatFileStagingChange: (beatId, active) => {
        setBeatCloudUpdateBusy(beatId, active, false);
      },
      onLibraryFileStagingChange: active => {
        if (!reviewSkeletonEnabled) return;
        setLibraryDropStaging(active);
      },
      onBrowserBeatFileDrop: browserFileImport ? handleBrowserBeatFileDrop : undefined,
      onBrowserLibraryFileDrop: browserFileImport ? importDroppedBrowserFiles : undefined,
      onLibraryFileDrop: async roots => {
        await importDroppedPaths(roots.map(root => root.path));
      },
      onEmptyFileDrop: async () => {
        await appAlert({
          title: "Nothing to import",
          message: "The desktop drag source reported files, but the app could not access any usable file or folder paths.",
        });
      },
      onError: async error => {
        console.error("HTML5 drag & drop failed:", error);
        await appAlert({ title: "Drag & drop failed", message: String(error), danger: true });
      },
    });
  }, [
    nativeDropAvailable,
    browserFileImport,
    reviewSkeletonEnabled,
    beatsLatestRef,
    setDropActive,
    setBeatCloudUpdateBusy,
    setBeatFileDrop,
    setLibraryDropStaging,
    handleDropArtwork,
    handleAutoProjectDrop,
    handleBrowserBeatFileDrop,
    importDroppedBrowserFiles,
    importDroppedPaths,
  ]);
}
'''
Path("src/features/dragdrop/useHtmlLibraryDrop.ts").write_text(hook, encoding="utf-8")

test = '''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const app = read("src/App.tsx");
const owner = read("src/features/dragdrop/useHtmlLibraryDrop.ts");
const controller = read("src/features/dragdrop/htmlDropController.ts");

describe("task 8.2 HTML/browser drop extraction", () => {
  it("moves controller installation and browser beat routing out of App", () => {
    expect(app).toContain("useHtmlLibraryDrop({");
    expect(app).not.toContain("installHtmlDropController");
    expect(app).not.toContain("const handleBrowserBeatFileDrop = useCallback");
    expect(owner).toContain("return installHtmlDropController({");
    expect((owner.match(/installHtmlDropController\\(/g) ?? []).length).toBe(1);
    expect(owner).toContain("const handleBrowserBeatFileDrop = useCallback");
  });

  it("keeps Windows on the native owner and Mac/browser HTML arbitration intact", () => {
    expect(owner).toContain("const windowsNativeDrop = nativeDropAvailable && /Windows/i.test(navigator.userAgent);");
    expect(owner).toContain("if (windowsNativeDrop) return;");
    expect(controller).toContain("waitForNativeLibraryDropClaim(htmlDropStartedAt)");
    expect(controller).toContain("captureArtworkSourcesFromDataTransfer(dt)");
  });

  it("preserves browser artwork fallback before generic file import", () => {
    expect(owner).toContain("for (const source of sources)");
    expect(owner).toContain("fetchInternetArtworkDataUrl(source.url)");
    expect(owner).toContain("artworkFileToDataUrl(source.file)");
    expect(owner).toContain("await handleDropArtwork(beat, imageData)");
    expect(controller.indexOf("if (artworkBeatId && artworkCandidate)")).toBeLessThan(controller.indexOf("if (!hasFilePayload(dt))"));
  });

  it("keeps browser asset/project and library import actions explicit", () => {
    expect(owner).toContain('name.endsWith(".mp3") ? "MASTER"');
    expect(owner).toContain('name.endsWith(".wav") ? "WAV"');
    expect(owner).toContain('name.endsWith(".zip") ? "PROJECT"');
    expect(owner).toContain("handleBrowserBeatAssetDrop(beat, file, kind)");
    expect(owner).toContain("handleBrowserProjectDrop(beat, file)");
    expect(owner).toContain("onBrowserLibraryFileDrop: browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(owner).toContain("await importDroppedPaths(roots.map(root => root.path))");
  });

  it("preserves staged Desktop beat handling and Backup exclusion", () => {
    expect(owner).toContain("isBackupFolderPath(root.path)");
    expect(owner).toContain("cleanupStagedDropPaths([root.path])");
    expect(owner).toContain("const autoResult = await handleAutoProjectDrop(beat, root.path)");
    expect(owner).toContain("setBeatFileDrop({ beat, filePath: root.path, kind: root.kind })");
  });
});
'''
Path("tests/integration/appHtmlLibraryDropExtraction.test.ts").write_text(test, encoding="utf-8")

regression = Path("scripts/regression-import-native.mjs")
text = regression.read_text(encoding="utf-8")
anchor = 'const htmlController = read("src/features/dragdrop/htmlDropController.ts");\n'
addition = 'const htmlDropOwner = read("src/features/dragdrop/useHtmlLibraryDrop.ts");\n'
if addition not in text:
    require(anchor in text, "regression-import-native read anchor missing")
    text = text.replace(anchor, anchor + addition, 1)
old = '''const fallbackGuard = app.indexOf("const windowsNativeDrop = isTauriAvailable && /Windows/i.test(navigator.userAgent);");
const fallbackReturn = app.indexOf("if (windowsNativeDrop) return;", fallbackGuard);
const fallbackInstall = app.indexOf("return installHtmlDropController(", fallbackReturn);
if (fallbackGuard < 0 || fallbackReturn < 0 || fallbackInstall < 0) fail("Windows is no longer excluded from the HTML DataTransfer fallback.");
'''
new = '''const fallbackGuard = htmlDropOwner.indexOf("const windowsNativeDrop = nativeDropAvailable && /Windows/i.test(navigator.userAgent);");
const fallbackReturn = htmlDropOwner.indexOf("if (windowsNativeDrop) return;", fallbackGuard);
const fallbackInstall = htmlDropOwner.indexOf("return installHtmlDropController(", fallbackReturn);
if (fallbackGuard < 0 || fallbackReturn < 0 || fallbackInstall < 0) fail("Windows is no longer excluded from the HTML DataTransfer fallback.");
if (!app.includes("useHtmlLibraryDrop({")) fail("App no longer composes the extracted HTML drop owner.");
if (app.includes("installHtmlDropController")) fail("HTML controller installation leaked back into App.tsx.");
'''
require(old in text, "regression-import-native fallback block missing")
regression.write_text(text.replace(old, new, 1), encoding="utf-8")

regressions = Path("scripts/run-regressions.mjs")
text = regressions.read_text(encoding="utf-8")
anchor = '  const controller = readFileSync(path.join(root, "src", "features", "dragdrop", "htmlDropController.ts"), "utf8");\n'
addition = '  const htmlDropOwner = readFileSync(path.join(root, "src", "features", "dragdrop", "useHtmlLibraryDrop.ts"), "utf8");\n'
if addition not in text:
    require(anchor in text, "run-regressions controller anchor missing")
    text = text.replace(anchor, anchor + addition, 1)
old = '  if (!app.includes("windowsNativeDrop") || !app.includes("if (windowsNativeDrop) return")) fail("HTML DataTransfer staging is still installed on Windows and can race native filesystem drops.");\n'
new = '  if (!htmlDropOwner.includes("windowsNativeDrop") || !htmlDropOwner.includes("if (windowsNativeDrop) return")) fail("HTML DataTransfer staging is still installed on Windows and can race native filesystem drops.");\n  if (!app.includes("useHtmlLibraryDrop({")) fail("App no longer composes the extracted HTML/browser drop owner.");\n  if (app.includes("installHtmlDropController")) fail("App.tsx took ownership of HTML controller installation again.");\n'
require(old in text, "run-regressions Windows ownership guard missing")
regressions.write_text(text.replace(old, new, 1), encoding="utf-8")
