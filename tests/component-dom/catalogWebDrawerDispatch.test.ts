import { describe, expect, it, vi } from "vitest";
import { dispatchWebDrawerSave } from "../../src/features/library/catalog/catalogBeatEditor";
import type { Beat } from "../../src/types";

const beat = { id: "b1", name: "Beat" } as Beat;

function handlers() {
  return { review: vi.fn(async () => {}), edit: vi.fn(async () => {}), bulk: vi.fn() };
}

describe("dispatchWebDrawerSave (M3.2b)", () => {
  it("envía la revisión de importación solo al guardado de revisión, con su progreso", async () => {
    const h = handlers();
    const onProgress = vi.fn();
    await dispatchWebDrawerSave({ kind: "review", updated: beat, onProgress }, h);
    expect(h.review).toHaveBeenCalledOnce();
    expect(h.review).toHaveBeenCalledWith(beat, onProgress);
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.bulk).not.toHaveBeenCalled();
  });

  it("envía la edición completa (archivos, portada quitada y progreso) al guardado del catálogo", async () => {
    const h = handlers();
    const request = { kind: "edit" as const, original: beat, updated: { ...beat, name: "Nuevo" } as Beat, files: {}, artworkRemoved: true, onProgress: vi.fn() };
    await dispatchWebDrawerSave(request, h);
    expect(h.edit).toHaveBeenCalledOnce();
    expect(h.edit).toHaveBeenCalledWith(request);
    expect(h.review).not.toHaveBeenCalled();
    expect(h.bulk).not.toHaveBeenCalled();
  });

  it("envía el lote con sus cambios y el modo de tags, y sin modo cuando no se tocan tags", () => {
    const h = handlers();
    dispatchWebDrawerSave({ kind: "bulk", updates: { tags: ["a"] }, options: { tagsMode: "remove" } }, h);
    expect(h.bulk).toHaveBeenLastCalledWith({ tags: ["a"] }, { tagsMode: "remove" });
    dispatchWebDrawerSave({ kind: "bulk", updates: { bpm: "120" } }, h);
    expect(h.bulk).toHaveBeenLastCalledWith({ bpm: "120" }, undefined);
    expect(h.bulk).toHaveBeenCalledTimes(2);
    expect(h.review).not.toHaveBeenCalled();
    expect(h.edit).not.toHaveBeenCalled();
  });
});
