// @vitest-environment jsdom
import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogServices } from "../../src/features/library/catalog/catalogLibraryProvider";
import { useCatalogGalleryScope } from "../../src/features/library/catalog/useCatalogGalleryScope";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

type Scope = ReturnType<typeof useCatalogGalleryScope>;
type Action = "search" | "sort" | "tags";

function Probe({ options, onScope }: {
  options: Parameters<typeof useCatalogGalleryScope>[0];
  onScope: (scope: Scope) => void;
}) {
  const scope = useCatalogGalleryScope(options);
  useLayoutEffect(() => { onScope(scope); }, [onScope, scope]);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("R-002 · orden y filtros diferidos de Gallery", () => {
  it("publica la secuencia exacta de consultas, historial y facetas de la Gallery", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { href } = window.location;
    const historyState = window.history.state;
    window.history.replaceState(null, "", "/gallery");
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const api = createCatalogFakeApi({ n: 2, generate: (i) => ({ name: `Beat ${i}`, tags: i ? ["odd", "shared"] : ["even", "shared"] }) });
    const list = vi.spyOn(api, "listBeats");
    const facets = vi.spyOn(api, "facets");
    const server = createCatalogFakeCommands({ beats: fakeBeats(2) });
    const accountId = "fake-user";
    const context = { authority_era: "era-fake", authority_epoch: "1", revision: "1" };
    const services = createCatalogServices({
      api, accountId, context, fetchImpl: server.fetchImpl,
      baseUrl: () => "https://cloud.invalid/api", token: () => "fake", csrf: () => "fake",
      direct: server.directPort, prefixCache: null, artworkCache: null,
    });
    const root = createRoot(document.createElement("div"));
    let scope!: Scope;
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const expected = (q: string, includeTags: string[], excludeTags: string[], includeMode: "any" | "all", sort: "rating" | "bpm") =>
      ({ state: "ACTIVE", q, includeTags, excludeTags, includeMode, sort, limit: 240, includeTotal: true, cursor: null, edge: null });
    const checkFacets = (entries: [string, number][]) => {
      expect(scope.allTags).toEqual(entries.map(([tag]) => tag));
      expect(scope.tagSuggestions).toEqual(scope.allTags);
      expect([...scope.tagFrequency]).toEqual(entries);
    };

    try {
      await act(async () => { root.render(<Probe options={{ services, accountId, context }} onScope={(value) => { scope = value; }} />); });
      const originalFacets: [string, number][] = [["shared", 2], ["even", 1], ["odd", 1]];
      checkFacets(originalFacets);
      expect(list).toHaveBeenCalledTimes(1);
      await advance(300);
      expect(replace.mock.calls).toEqual([[{ catalog: true, anchor: null }, "", window.location.origin + "/gallery"]]);
      await act(async () => { scope.setSearch("Be"); });
      await advance(100);
      await act(async () => {
        scope.setSearch(" Beat ");
        scope.handleTagClick("odd", {});
        scope.handleTagClick("shared", {});
      });
      expect([scope.search, ...scope.includedTags]).toEqual([" Beat ", "odd", "shared"]);
      await advance(249);
      expect(list).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(list).toHaveBeenCalledTimes(2);
      checkFacets(originalFacets);

      await act(async () => { await services.store.setQuery({ ...scope.query.filters, includeMode: "all" }, scope.sortBy); });
      await act(async () => {
        scope.handleTagClick("odd", {});
        scope.handleTagClick("even", { altKey: true });
        scope.setSortBy("bpm");
      });
      expect([...scope.includedTags]).toEqual(["shared"]);
      expect([...scope.excludedTags]).toEqual(["even"]);
      await advance(249);
      expect(list).toHaveBeenCalledTimes(4);
      await advance(1);
      expect(list).toHaveBeenCalledTimes(5);
      checkFacets(originalFacets);
      expect(facets.mock.calls).toEqual([[{ scope: "ACTIVE", q: undefined, limit: 240 }]]);

      api.fake.beats[1].tags.push("new");
      api.fake.bumpRevision();
      await act(async () => { services.store.notifyLibraryChanged(); });
      checkFacets([["shared", 2], ["even", 1], ["new", 1], ["odd", 1]]);
      expect(facets.mock.calls).toEqual([
        [{ scope: "ACTIVE", q: undefined, limit: 240 }],
        [{ scope: "ACTIVE", q: undefined, limit: 240 }],
      ]);
      expect((await Promise.all(facets.mock.results.map(({ value }) => value))).map(({ revision }) => revision)).toEqual(["1", "2"]);
      expect(list.mock.calls.map(([request]) => request)).toEqual([
        expected("", [], [], "any", "rating"),
        expected("Beat", ["odd", "shared"], [], "any", "rating"),
        expected("Beat", ["odd", "shared"], [], "all", "rating"),
        expected("Beat", ["odd", "shared"], [], "all", "bpm"),
        expected("Beat", ["shared"], ["even"], "all", "bpm"),
        expected("Beat", ["shared"], ["even"], "all", "bpm"),
      ]);
      expect(scope.snapshot.queryKey).toBe('{"state":"ACTIVE","q":"beat","includeMode":"all","include":["shared"],"exclude":["even"],"sort":"bpm"}');
      expect(scope.playback.query).toEqual({ filters: { state: "ACTIVE", q: "Beat", includeTags: ["shared"], excludeTags: ["even"], includeMode: "all" }, sort: "bpm", revision: "2" });
      await advance(300);
      expect(push.mock.calls.map(([, , url]) => new URL(String(url)).search)).toEqual([
        "?bgQ=Beat&bgInclude=odd&bgInclude=shared",
        "?bgQ=Beat&bgInclude=odd&bgInclude=shared&bgMode=all",
        "?bgSort=bpm&bgQ=Beat&bgInclude=odd&bgInclude=shared&bgMode=all",
        "?bgSort=bpm&bgQ=Beat&bgInclude=shared&bgExclude=even&bgMode=all",
      ]);
      expect(replace).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      await services.teardown();
      window.history.replaceState(historyState, "", href);
    }
  });

  it("mantiene el borrador al sustituir el servicio e ignora las facetas pendientes del anterior", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { href } = window.location;
    const historyState = window.history.state;
    window.history.replaceState(null, "", "/gallery");
    const accountId = "fake-user";
    const context = { authority_era: "era-fake", authority_epoch: "1", revision: "1" };
    const server = createCatalogFakeCommands({ beats: fakeBeats(1) });
    const makeOptions = (api: ReturnType<typeof createCatalogFakeApi>) => ({
      accountId, context,
      services: createCatalogServices({
        api, accountId, context, fetchImpl: server.fetchImpl,
        baseUrl: () => "https://cloud.invalid/api", token: () => "fake", csrf: () => "fake",
        direct: server.directPort, prefixCache: null, artworkCache: null,
      }),
    });
    const previousApi = createCatalogFakeApi({ n: 1, generate: () => ({ tags: ["anterior"] }) });
    let releaseFacets!: () => void;
    const holdFacets = new Promise<void>((resolve) => { releaseFacets = resolve; });
    const readFacets = previousApi.facets;
    const pendingFacets = vi.spyOn(previousApi, "facets").mockImplementation(async (request) => {
      await holdFacets;
      return readFacets(request);
    });
    const nextApi = createCatalogFakeApi({ n: 1, generate: () => ({ tags: ["vigente"] }) });
    const nextList = vi.spyOn(nextApi, "listBeats");
    const previous = makeOptions(previousApi);
    const next = makeOptions(nextApi);
    const root = createRoot(document.createElement("div"));
    let scope!: Scope;
    const render = (options: typeof previous) => act(async () => { root.render(<Probe options={options} onScope={(value) => { scope = value; }} />); });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    try {
      await render(previous);
      expect(pendingFacets).toHaveBeenCalledTimes(1);
      await act(async () => { scope.setSearch("Beat"); });
      await advance(100);
      await next.services.store.loadFirst();
      await render(next);
      expect(scope.search).toBe("Beat");
      expect(scope.allTags).toEqual(["vigente"]);
      await act(async () => { releaseFacets(); });
      expect(scope.allTags).toEqual(["vigente"]);
      await advance(249);
      expect(nextList).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(nextList.mock.calls.map(([request]) => request.q)).toEqual(["", "Beat"]);
      expect(previousApi.fake.counters.listBeats).toBe(1);
    } finally {
      act(() => root.unmount());
      releaseFacets();
      await previous.services.teardown();
      await next.services.teardown();
      window.history.replaceState(historyState, "", href);
    }
  });

  it("publica el cambio de includeMode a reproducción con los demás filtros intactos", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const originalHref = window.location.href;
    const originalHistory = window.history.state;
    window.history.replaceState(null, "", "/gallery?bgInclude=odd&bgInclude=t3");
    const beats = fakeBeats(4);
    const server = createCatalogFakeCommands({ beats });
    const api = createCatalogFakeApi({
      n: beats.length,
      generate: (i) => ({ ...beats[i], state: "ACTIVE", manualRank: beats[i].rank }),
    });
    const context = { authority_era: "era-fake", authority_epoch: "1", revision: server.revision() };
    for (let rev = 1; rev < Number(context.revision); rev++) api.fake.bumpRevision();
    const accountId = "fake-user";
    const services = createCatalogServices({
      api, accountId, context, fetchImpl: server.fetchImpl,
      baseUrl: () => "https://cloud.invalid/api", token: () => "fake", csrf: () => "fake",
      direct: server.directPort, prefixCache: null, artworkCache: null,
    });
    const root = createRoot(document.createElement("div"));

    try {
      await act(async () => {
        root.render(<Probe options={{ services, accountId, context }} onScope={() => {}} />);
      });
      const initialQuery = services.playback.getSnapshot().query!;
      expect(initialQuery.filters).toMatchObject({ includeTags: ["odd", "t3"], includeMode: "any" });
      const filters = { ...initialQuery.filters, includeMode: "all" as const };
      await act(async () => { await services.store.setQuery(filters, initialQuery.sort); });

      expect(services.store.getSnapshot().filters).toEqual(filters);
      expect(services.playback.getSnapshot().query).toEqual({ ...initialQuery, filters });
    } finally {
      act(() => root.unmount());
      await services.teardown();
      window.history.replaceState(originalHistory, "", originalHref);
    }
  });

  it.each<[Action, Action]>([["search", "sort"], ["sort", "tags"], ["sort", "search"], ["tags", "sort"]])(
    "%s → %s conserva el orden y la pista en curso al aplicar el filtro",
    async (first, second) => {
      vi.useFakeTimers();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const originalHref = window.location.href;
      const originalHistory = window.history.state;
      window.history.replaceState(null, "", "/gallery");

      // Solo se simula el navegador multimedia. El hook de audio y la sesión son reales.
      const audio = document.createElement("audio");
      Object.defineProperty(audio, "duration", { value: 100 });
      const load = vi.spyOn(audio, "load").mockImplementation(() => {});
      const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
      const play = vi.spyOn(audio, "play").mockImplementation(async () => {
        audio.dispatchEvent(new Event("playing"));
      });
      vi.stubGlobal("Audio", function () { return audio; });
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", class extends URL {
        static createObjectURL() { return "blob:fake/playing-beat"; }
        static revokeObjectURL = revokeObjectURL;
      });

      const beats = fakeBeats(4);
      const server = createCatalogFakeCommands({ beats });
      const api = createCatalogFakeApi({
        n: beats.length,
        generate: (i) => ({ ...beats[i], state: "ACTIVE", manualRank: beats[i].rank }),
      });
      const context = { authority_era: "era-fake", authority_epoch: "1", revision: server.revision() };
      for (let rev = 1; rev < Number(context.revision); rev++) api.fake.bumpRevision();
      const listBeats = vi.spyOn(api, "listBeats");
      const accountId = "fake-user";
      const services = createCatalogServices({
        api, accountId, context, fetchImpl: server.fetchImpl,
        baseUrl: () => "https://cloud.invalid/api", token: () => "fake", csrf: () => "fake",
        direct: server.directPort, prefixCache: null, artworkCache: null,
      });
      const root = createRoot(document.createElement("div"));
      let scope!: Scope;
      const excludedTag = first === "tags" ? "t3" : null;
      const actions = {
        search: () => scope.setSearch("Beat 2"),
        sort: () => scope.setSortBy("bpm"),
        tags: () => {
          scope.handleTagClick("odd", {});
          if (excludedTag) scope.handleTagClick(excludedTag, { altKey: true });
        },
      };
      const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

      try {
        await act(async () => {
          root.render(<Probe options={{ services, accountId, context }} onScope={(value) => { scope = value; }} />);
        });
        expect(scope.snapshot.status).toBe("ready");
        const dto = scope.snapshot.blocks.flatMap((block) => block.items).find((item) => item.id === "g0")!;
        const beat = scope.toBeat(dto);
        await act(async () => { scope.toggleSelection(beat, false); scope.handlePlay(beat); });
        expect(scope.isSelected(beat.id)).toBe(true);
        const selectionId = scope.interaction.selection.selectionId;
        expect(selectionId).toBeTruthy();
        expect(scope.interaction.selection.anchor?.beatId).toBe(beat.id);
        expect(scope.playback.status).toBe("playing");
        const source = scope.playback.source!;
        expect(audio.src).toBe(source.url);
        await act(async () => {
          audio.currentTime = 37;
          audio.dispatchEvent(new Event("timeupdate"));
        });
        expect(scope.audio).toMatchObject({ playingId: beat.id, isPlaying: true, progress: 0.37 });
        const loadCount = load.mock.calls.length;
        const pauseCount = pause.mock.calls.length;
        expect(play).toHaveBeenCalledTimes(1);
        listBeats.mockClear();

        await act(async () => { actions[first](); });
        await advance(100);
        await act(async () => { actions[second](); });
        await advance(first === "sort" ? 249 : 149);

        expect(listBeats).toHaveBeenCalledTimes(1);
        expect(listBeats.mock.lastCall?.[0]).toMatchObject({ sort: "bpm", q: "", includeTags: [], excludeTags: [] });
        expect(scope.interaction.selection).toMatchObject({ selectionId, count: 1, status: "active", anchor: null });
        expect(scope.isSelected(beat.id)).toBe(true);

        await advance(1);
        expect(scope.interaction.selection).toMatchObject({ count: 0, status: "none", notice: "Selección borrada al cambiar los filtros" });
        expect(scope.isSelected(beat.id)).toBe(false);
        await advance(350); // La URL también sobrevive al replace diferido del ancla.

        expect(scope.snapshot.status).toBe("ready");
        expect(scope.snapshot.blocks.flatMap((block) => block.items.map((item) => item.id))).not.toContain(beat.id);
        expect(scope.playback).toMatchObject({ status: "playing", current: { beatId: beat.id }, progress: 0.37 });
        expect(scope.playback.source).toBe(source);
        expect(services.media.refcount(source.cacheKey)).toBe(1);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        expect(scope.audio).toMatchObject({ playingId: beat.id, isPlaying: true, progress: 0.37 });
        expect(audio.src).toBe(source.url);
        expect(audio.currentTime).toBe(37);
        expect(play).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledTimes(loadCount);
        expect(pause).toHaveBeenCalledTimes(pauseCount);

        const tags = first === "tags" || second === "tags";
        const filters = { q: tags ? "" : "Beat 2", includeTags: tags ? ["odd"] : [], excludeTags: excludedTag ? [excludedTag] : [] };
        expect(listBeats).toHaveBeenCalledTimes(2);
        expect.soft(listBeats.mock.lastCall?.[0]).toMatchObject({ ...filters, sort: "bpm" });
        expect.soft(scope.playback.query).toMatchObject({ filters, sort: "bpm" });
        expect(window.location.pathname).toBe("/gallery");
        expect.soft(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
          bgSort: "bpm",
          ...(tags ? { bgInclude: "odd" } : { bgQ: "Beat 2" }),
          ...(excludedTag ? { bgExclude: excludedTag } : {}),
        });
      } finally {
        act(() => root.unmount());
        await services.teardown();
        window.history.replaceState(originalHistory, "", originalHref);
      }
    },
  );
});
