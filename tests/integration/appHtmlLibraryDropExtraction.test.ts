import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const app = read("src/app/useBeatGalerComposition.ts").replaceAll("../", "./");
const owner = read("src/features/dragdrop/useHtmlLibraryDrop.ts");
const controller = read("src/features/dragdrop/htmlDropController.ts");

describe("task 8.2 HTML/browser drop extraction", () => {
  it("moves controller installation and browser beat routing out of App", () => {
    expect(app).toContain("useHtmlLibraryDrop({");
    expect(app).not.toContain("installHtmlDropController");
    expect(app).not.toContain("const handleBrowserBeatFileDrop = useCallback");
    expect(owner).toContain("return installHtmlDropController({");
    expect((owner.match(/installHtmlDropController\(/g) ?? []).length).toBe(1);
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
