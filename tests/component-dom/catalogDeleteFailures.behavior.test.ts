import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogInteractionStore } from "../../src/features/library/catalog/catalogInteractionStore";
import type { CatalogServices } from "../../src/features/library/catalog/catalogLibraryProvider";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import { createCatalogMutations } from "../../src/features/library/catalog/catalogMutations";
import { createCatalogPlaybackSession } from "../../src/features/library/catalog/catalogPlaybackSession";
import { createCatalogQueryStore } from "../../src/features/library/catalog/catalogQueryStore";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";
import { useCatalogGalleryScope, type CatalogGalleryScope } from "../../src/features/library/catalog/useCatalogGalleryScope";
import type { Beat } from "../../src/types";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";

vi.mock("../../src/platform", () => ({
  platform: {
    media: { resolveUrl: (url: string) => url, releasePlayback: vi.fn() },
    diagnostics: { audioEvent: async () => {} },
  },
}));

type DeleteOutcome = "expired" | "conflict" | "offline" | "confirmed";
const renamed = "Nombre cambiado en otro dispositivo";
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  });
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function mountCatalog(outcome: DeleteOutcome, { holdTrash = false, unavailable = false, holdSecondSource = false } = {}) {
  const api = createCatalogFakeApi({ n: 4, generate: (i) => ({ rating: 0, name: `Beat ${i}` }) });
  const target = api.fake.beats[0];
  const context = await api.context();
  const accountId = context.user_id;
  let confirmTrash!: () => void;
  const confirmation = new Promise<void>((resolve) => { confirmTrash = resolve; });
  let deliverSource!: () => void;
  const secondSource = new Promise<void>((resolve) => { deliverSource = resolve; });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method !== "POST" || !String(input).endsWith("/catalog/v1/beats/trash")) {
      throw new Error(`Unexpected catalog request: ${init?.method} ${input}`);
    }
    if (outcome === "expired") {
      api.fake.setFailure({ kind: "status", status: 401, code: "UNAUTHENTICATED" });
      return Response.json({ code: "UNAUTHENTICATED", error: "Session expired. Sign in again." }, { status: 401 });
    }
    if (outcome === "conflict") {
      target.name = renamed;
      api.fake.bumpRevision("BEAT_PATCHED", target.id);
      return Response.json({ code: "VERSION_CONFLICT" }, { status: 409 });
    }
    if (outcome === "offline") {
      api.fake.setFailure({ kind: "offline" });
      throw new TypeError("Failed to fetch");
    }
    if (holdTrash) await confirmation;
    target.state = "TRASH";
    api.fake.bumpRevision("BEAT_TRASHED", target.id);
    return Response.json({ items: [{ beatId: target.id, version: "2" }], revision: "2", operationId: "trash-1", replay: false });
  });
  const http = {
    fetchImpl, baseUrl: () => "https://catalog.invalid",
    token: () => null, csrf: () => null,
    headers: () => ({ era: context.authority_era, epoch: context.authority_epoch }),
  };
  const commands = createCatalogCommandsApi(http);
  const store = createCatalogQueryStore({ api, accountId, blockSize: 2, maxBlocks: 1 });
  const release = vi.fn();
  const playback = createCatalogPlaybackSession({
    api: commands,
    accountId: () => accountId,
    resolveSet: async () => ({ setId: "empty", memberCount: 0 }),
    resolveFile: async () => { throw new Error("Expected a file ID from the catalog row"); },
    acquireSource: async (fileId) => {
      if (unavailable) throw new Error("No audio");
      if (holdSecondSource && fileId === "f-g1") await secondSource;
      return { url: `blob:${fileId}`, cacheKey: fileId, bytes: 1, release };
    },
  });
  const services: CatalogServices = {
    api, store, playback,
    interaction: createCatalogInteractionStore({ api, commands, accountId: () => accountId }),
    media: createCatalogMediaClient({ ...http, accountId: () => accountId, direct: null }),
    mutations: createCatalogMutations({
      commands, transfer: createCatalogTransfer({ ...http, direct: null }), accountId: () => accountId,
      refStore: { load: () => [], save: () => {} },
    }),
    async teardown() {
      await playback.teardown();
      await services.interaction.teardown();
      services.media.teardown();
      store.teardown();
    },
  };
  let scope!: CatalogGalleryScope;
  const audioElement = document.createElement("audio");
  let paused = true;
  Object.defineProperties(audioElement, { paused: { get: () => paused }, duration: { value: 20 } });
  const playAudio = vi.spyOn(audioElement, "play").mockImplementation(async () => {
    paused = false;
    audioElement.dispatchEvent(new Event("play"));
  });
  vi.spyOn(audioElement, "pause").mockImplementation(() => {
    paused = true;
    audioElement.dispatchEvent(new Event("pause"));
  });
  vi.stubGlobal("Audio", function () { return audioElement; });
  function Probe() {
    scope = useCatalogGalleryScope({ services, accountId, context });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  cleanups.push(async () => {
    confirmTrash();
    deliverSource();
    await act(async () => root.unmount());
    await services.teardown();
  });
  await act(async () => root.render(createElement(Probe)));
  expect(scope.snapshot.status).toBe("ready");
  const dto = store.itemAt(0)!;
  expect(dto.id).toBe(target.id);
  const beat = scope.toBeat(dto);
  const resident = () => store.getSnapshot().blocks.flatMap((block) => block.items);
  return {
    target, release, resident, audioElement, playAudio,
    get scope() { return scope; },
    async playBeat(index = 0) {
      await act(async () => { scope.handlePlay(scope.toBeat(store.itemAt(index)!)); });
    },
    async endAudio() {
      await act(async () => {
        paused = true;
        audioElement.currentTime = audioElement.duration;
        audioElement.dispatchEvent(new Event("ended"));
      });
    },
    async confirmTrash() { await act(async () => confirmTrash()); },
    async deliverSource() { await act(async () => deliverSource()); },
    async playAndEvict() {
      await act(async () => {
        scope.handlePlay(beat);
        scope.addToQueue(beat);
      });
      await act(async () => {
        store.observeViewport({ firstOrdinal: 2, lastOrdinal: 3, perViewport: 1 });
      });
      expect(store.getSnapshot().metrics.evictions).toBeGreaterThan(0);
      expect(resident().map((item) => item.id)).toEqual(["g2", "g3"]);
      expect(scope.audio).toMatchObject({ playingId: beat.id, isPlaying: true });
      expect(scope.playback).toMatchObject({ current: { beatId: beat.id }, source: { cacheKey: dto.playback?.fileId } });
    },
    async deleteBeat(targetBeat: Beat = beat) {
      await act(async () => scope.deleteBeat(targetBeat));
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, request] = fetchImpl.mock.calls[0];
      expect([url, request?.method]).toEqual(["https://catalog.invalid/catalog/v1/beats/trash", "POST"]);
      expect(JSON.parse(String(request?.body))).toEqual({ items: [{ beatId: beat.id, expectedVersion: dto.version }] });
    },
  };
}

describe("Borrado individual del catálogo", () => {
  it("401 activa el estado de sesión expirada y conserva la tarjeta confirmada", async () => {
    const h = await mountCatalog("expired");
    await h.deleteBeat();
    expect(h.scope.snapshot).toMatchObject({ status: "unauthenticated", edgeError: { status: 401, code: "UNAUTHENTICATED" } });
    expect(h.scope.cloudSessionVerified).toBe(false);
    expect(h.resident().map((item) => item.id)).toContain(h.target.id);
  });

  it("409 avisa del conflicto y refresca el mismo beat con los datos del servidor", async () => {
    const h = await mountCatalog("conflict");
    await h.deleteBeat();
    expect(h.scope.notice).toMatch(/cambió en otro dispositivo/);
    expect(h.scope.snapshot.revision).toBe("2");
    expect(h.resident()).toContainEqual(expect.objectContaining({ id: h.target.id, name: renamed }));
  });

  it("offline expone el error y conserva el beat en la ventana", async () => {
    const h = await mountCatalog("offline");
    const before = h.resident();
    await h.deleteBeat();
    expect(h.scope.notice).toContain("Could not reach BeatGaler Cloud");
    expect(h.resident()).toEqual(before);
  });

  it("offline conserva el audio, la fuente y la cola del beat evictado", async () => {
    const h = await mountCatalog("offline");
    await h.playAndEvict();
    const { current, source, queue } = h.scope.playback;
    expect(h.scope.currentBeat?.id).toBe(h.target.id);
    await h.deleteBeat(h.scope.currentBeat!);
    expect(h.scope.notice).toContain("Could not reach BeatGaler Cloud");
    expect(h.scope.playback).toMatchObject({ current, source, queue, status: "playing" });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.scope.audio).toMatchObject({ playingId: h.target.id, isPlaying: true });
  });

  it("al confirmar, elimina el beat evictado y libera sus referencias del Player", async () => {
    const h = await mountCatalog("confirmed");
    await h.playAndEvict();
    expect(h.scope.currentBeat?.id).toBe(h.target.id);
    await h.deleteBeat(h.scope.currentBeat!);
    expect(h.scope.snapshot.totalLibrary).toBe(3);
    expect(h.resident().map((item) => item.id)).not.toContain(h.target.id);
    expect(h.scope.audio).toMatchObject({ playingId: null, isPlaying: false });
    expect.soft(h.scope.playback).toMatchObject({ current: null, source: null, queue: [] });
    expect.soft(h.release).toHaveBeenCalledOnce();
  });
});

it("la pausa de Gallery invalida una selección que todavía está cargando", async () => {
  const h = await mountCatalog("confirmed", { holdSecondSource: true });
  await h.playBeat();
  await h.playBeat(1);
  expect(h.scope.playback.status).toBe("loading");
  expect(h.scope.audio).toMatchObject({ playingId: h.target.id, isPlaying: true });
  await act(async () => h.scope.togglePause());
  await h.deliverSource();
  expect(h.scope.playback).toMatchObject({ current: { beatId: h.target.id }, status: "paused" });
  expect(h.scope.audio).toMatchObject({ playingId: h.target.id, isPlaying: false });
  expect(h.playAudio).toHaveBeenCalledOnce();
  expect(h.release).toHaveBeenCalledOnce();
});

it("espera la confirmación y conserva el segundo beat si empezó a sonar durante el borrado", async () => {
  const h = await mountCatalog("confirmed", { holdTrash: true });
  await h.playAndEvict();
  await h.deleteBeat(h.scope.currentBeat!);
  expect(h.scope.audio).toMatchObject({ playingId: h.target.id, isPlaying: true });
  expect(h.release).not.toHaveBeenCalled();
  expect(h.scope.playback.queue.map(({ beatId }) => beatId)).toEqual([h.target.id]);

  await h.playBeat(2);
  expect(h.scope.audio).toMatchObject({ playingId: "g2", isPlaying: true });
  await h.confirmTrash();
  expect(h.scope.audio).toMatchObject({ playingId: "g2", isPlaying: true });
  expect(h.scope.playback).toMatchObject({ current: { beatId: "g2" }, queue: [] });
  expect(h.release).toHaveBeenCalledOnce();
});

it("avisa si el motor pierde el medio, después de reproducir sin aviso", async () => {
  const h = await mountCatalog("confirmed");
  await h.playBeat();
  expect(h.scope.audio.isPlaying).toBe(true);
  expect(h.scope.notice).toBeNull();

  await act(async () => { h.audioElement.dispatchEvent(new Event("error")); });
  expect(h.scope.notice).toBe("No se pudo reproducir este beat.");
});

it("avisa si no se puede adquirir la fuente del beat", async () => {
  const h = await mountCatalog("confirmed", { unavailable: true });
  await h.playBeat();
  expect(h.scope.playback.status).toBe("error");
  expect(h.playAudio).not.toHaveBeenCalled();
  expect(h.scope.notice).toBe("No se pudo reproducir este beat.");
});

it("repite una pista al terminar con el elemento de audio fuera del DOM", async () => {
  const h = await mountCatalog("confirmed");
  await h.playBeat();
  expect(h.audioElement.isConnected).toBe(false);
  expect(document.querySelector("audio")).toBeNull();
  await act(async () => { h.scope.cycleRepeat(); });
  await act(async () => { h.scope.cycleRepeat(); });
  expect(h.scope.playback.repeat).toBe("one");
  await h.endAudio();
  expect(h.audioElement.currentTime).toBe(0);
  expect(h.playAudio).toHaveBeenCalledTimes(2);
  expect(h.scope.audio).toMatchObject({ playingId: h.target.id, isPlaying: true });
});

it("no reinicia la pista al terminar con repetir desactivado", async () => {
  const h = await mountCatalog("confirmed");
  await h.playBeat();
  expect(h.scope.playback.repeat).toBe("off");
  await h.endAudio();
  expect(h.playAudio).toHaveBeenCalledOnce();
  expect(h.scope.audio.isPlaying).toBe(false);
});
