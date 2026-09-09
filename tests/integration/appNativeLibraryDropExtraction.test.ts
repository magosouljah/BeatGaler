import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const app = read("src/app/useBeatGalerComposition.ts").replaceAll("../", "./");
const owner = read("src/features/dragdrop/useNativeLibraryDrop.ts");
const targets = read("src/features/dragdrop/nativeDropTargets.ts");
const arbiter = read("src/features/dragdrop/nativeDropArbiter.ts");

describe("task 8.3 native drop extraction", () => {
  it("moves Tauri listener ownership out of App while keeping one composition point", () => {
    expect(app).toContain("useNativeLibraryDrop({");
    expect((app.match(/useNativeLibraryDrop\(\{/g) ?? []).length).toBe(1);
    expect(app).not.toContain("getCurrentWebview().onDragDropEvent");
    expect(app).not.toContain("const handleNativeDrop = async");
    expect(owner).toContain("getCurrentWebview().onDragDropEvent");
    expect((owner.match(/onDragDropEvent\(/g) ?? []).length).toBe(1);
    expect(owner).toContain("if (!nativeDropAvailable) return;");
  });

  it("preserves native routing, safety limit, original paths and zero-copy import", () => {
    expect(owner).toContain("const MAX_NATIVE_DROP_ITEMS = 50;");
    expect(owner).toContain("resolveNativeFilesystemDropTarget(payload.paths, payload.position)");
    expect(owner).toContain("if (payload.paths.length > MAX_NATIVE_DROP_ITEMS)");
    expect(owner).toContain("await importDroppedPaths(payload.paths)");
    expect(owner).toContain("No\n      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy.");
    expect(owner).not.toContain("stageCapturedHtmlDrop");
    const codeOnly = owner.replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toContain(".arrayBuffer(");
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
