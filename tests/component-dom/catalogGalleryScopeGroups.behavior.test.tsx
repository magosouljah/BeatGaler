// X4 — los grupos de useCatalogGalleryScope no cambian la identidad de sus miembros: un re-render sin cambios conserva las funciones
// estables (los consumidores memoizan sobre ellas, p. ej. las BeatCards y los atajos).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountEditHarness, type EditHarness } from "../helpers/catalogEditHarness";

let h: EditHarness | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
afterEach(async () => { vi.restoreAllMocks(); await h?.teardown(); h = undefined; vi.useRealTimers(); });

describe("useCatalogGalleryScope: identidad de los miembros agrupados", () => {
  it("un re-render sin cambios conserva las funciones estables de cada grupo y la superficie sigue acotada", async () => {
    h = await mountEditHarness();
    await h.flush();
    const before = h.scope();
    await h.rerender();
    await h.flush();
    const after = h.scope();
    expect(after).not.toBe(before);
    const stable: Array<[string, (s: typeof before) => unknown]> = [
      ["filters.setSearch", (s) => s.filters.setSearch], ["filters.setSortBy", (s) => s.filters.setSortBy], ["filters.handleTagClick", (s) => s.filters.handleTagClick],
      ["transport.togglePause", (s) => s.transport.togglePause], ["transport.seek", (s) => s.transport.seek], ["queue.toggleQueue", (s) => s.queue.toggleQueue],
      ["selection.toggleSelection", (s) => s.selection.toggleSelection], ["selection.finishSelection", (s) => s.selection.finishSelection],
      ["editor.deleteBeat", (s) => s.editor.deleteBeat], ["editor.replaceAudioByDrop", (s) => s.editor.replaceAudioByDrop], ["downloads.open", (s) => s.downloads.open],
      ["imports.addBeatsAndReview", (s) => s.imports.addBeatsAndReview], ["rename.open", (s) => s.rename.open], ["toBeat", (s) => s.toBeat], ["isSelected", (s) => s.isSelected],
    ];
    for (const [name, pick] of stable) expect(pick(after), name).toBe(pick(before));
    expect(Object.keys(after).length).toBeLessThanOrEqual(30);
  });
});
