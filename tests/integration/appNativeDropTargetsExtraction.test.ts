import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isNativeImagePath,
  resolveNativeExternalImageDropTarget,
  resolveNativeFilesystemDropTarget,
} from "../../src/features/dragdrop/nativeDropTargets";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const nativeDropOwner = readFileSync(resolve(process.cwd(), "src/features/dragdrop/useNativeLibraryDrop.ts"), "utf8");
const targets = readFileSync(resolve(process.cwd(), "src/features/dragdrop/nativeDropTargets.ts"), "utf8");

describe("task 8.1 native drop target extraction", () => {
  it("moves coordinate, scale, data-* and image classification ownership out of App", () => {
    expect(nativeDropOwner).toContain("resolveNativeFilesystemDropTarget(payload.paths, payload.position)");
    expect(nativeDropOwner).toContain("resolveNativeExternalImageDropTarget(position)");
    expect(app).not.toContain("const elementAtNativePosition =");
    expect(app).not.toContain("const isImagePath =");
    for (const marker of ["window.devicePixelRatio", "document.elementFromPoint", "[data-beat-artwork-id]", "[data-beat-card-id]", "[data-artwork-drop]", "[data-filerole]"]) expect(targets).toContain(marker);
    expect(targets).toContain('[data-library-scroll="true"]');
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
