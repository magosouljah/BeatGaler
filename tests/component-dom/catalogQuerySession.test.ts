import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, type CatalogSort } from "../../src/features/library/catalog/catalogApi";
import { createCatalogQuerySession } from "../../src/features/library/catalog/catalogQuerySession";

function setup() {
  const calls: string[] = [];
  const current = { filters: DEFAULT_FILTERS, sort: "rating" as CatalogSort, revision: "12" };
  const store = {
    getSnapshot: () => current,
    startedFromSeed: () => false,
    revalidate: vi.fn(async () => {}),
    loadFirst: vi.fn(async () => {}),
    loadLegacy: vi.fn(async () => {}),
    loadResume: vi.fn(async () => {}),
    setSort: vi.fn(async (sort: CatalogSort) => {
      calls.push("window.sort");
      current.sort = sort;
    }),
    setQuery: vi.fn(async () => { calls.push("window.query"); }),
    notifyLibraryChanged: vi.fn(),
  };
  const interaction = {
    getSnapshot: () => ({ selection: { status: "none" as const } }),
    onSortChanged: vi.fn(() => { calls.push("interaction.sort"); }),
    onFiltersChanged: vi.fn(() => {
      calls.push("interaction.filters");
      // La consulta debe arrancar mientras la liberación de la selección sigue pendiente.
      return new Promise<void>(() => {});
    }),
    onRevisionChanged: vi.fn(),
    loadFacets: vi.fn(async () => ({ items: [], startOrdinal: 0, totalFacets: 0, nextCursor: null, revision: "12" })),
    invalidateFacets: vi.fn(),
    refreshFlags: vi.fn(async () => {}),
  };
  const playback = { setQuery: vi.fn(async () => { calls.push("playback.query"); }) };
  const session = createCatalogQuerySession({
    store, interaction, playback,
    history: { pushQuery: vi.fn(), replaceAnchor: vi.fn() },
    schedule(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  });
  return { session, calls, current, store, interaction, playback };
}

const draft = (search: string) => ({
  search,
  includedTags: new Set(["z", "a"]),
  excludedTags: new Set(["omit"]),
});

afterEach(() => vi.useRealTimers());

it("notifica a interacción antes de cambiar la ventana y envía a reproducción la consulta publicada", () => {
  vi.useFakeTimers();
  const { session, calls, current, store, interaction, playback } = setup();
  session.deferFilters(draft("  beat  "), "10");
  session.setSort("bpm");
  vi.advanceTimersByTime(250);

  const filters = { ...DEFAULT_FILTERS, q: "beat", includeTags: ["a", "z"], excludeTags: ["omit"] };
  const published = { filters, sort: current.sort, revision: current.revision };
  session.syncPlayback(published);

  expect(calls).toEqual(["interaction.sort", "window.sort", "interaction.filters", "window.query", "playback.query"]);
  expect(interaction.onFiltersChanged).toHaveBeenCalledWith({ filters, sort: "bpm", revision: "12" });
  expect(store.setQuery).toHaveBeenCalledWith(filters, "bpm");
  expect(playback.setQuery).toHaveBeenCalledWith(published);
});

it("cancela el borrador anterior y espera 250 ms para aplicar el vigente", () => {
  vi.useFakeTimers();
  const { session, calls, store } = setup();
  const cancel = session.deferFilters(draft("anterior"), "10");
  vi.advanceTimersByTime(100);
  cancel();
  session.deferFilters(draft("vigente"), "10");
  vi.advanceTimersByTime(249);
  expect(calls).toEqual([]);

  vi.advanceTimersByTime(1);
  expect(calls).toEqual(["interaction.filters", "window.query"]);
  expect(store.setQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "vigente" }), "rating");
});
