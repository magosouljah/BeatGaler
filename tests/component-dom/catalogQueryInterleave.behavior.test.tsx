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
