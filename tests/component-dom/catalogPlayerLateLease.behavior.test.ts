// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudio } from "../../src/hooks/useAudio";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import { createCatalogPlaybackSession } from "../../src/features/library/catalog/catalogPlaybackSession";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

vi.mock("../../src/platform", () => ({
  platform: {
    media: { resolveUrl: (url: string) => url, releasePlayback: vi.fn() },
    diagnostics: { audioEvent: vi.fn(async () => undefined) },
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup({ streaming = false } = {}) {
  const catalog = createCatalogFakeApi({ n: 2 });
  const { items: [a, b] } = await catalog.listBeats({ sort: "manual" });
  const server = createCatalogFakeCommands({
    beats: fakeBeats(2),
    // El fake divide en dos partes. Con un byte entrega un MP3 de una sola parte.
    mediaBytes: () => new Uint8Array(streaming ? 1 : 4),
  });
  const accessRequested = deferred();
  const respondToAccess = deferred();
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await server.fetchImpl(input, init);
    if (String(input).endsWith(`/files/${a.playback!.fileId}/access`)) {
      accessRequested.resolve();
      await respondToAccess.promise;
    }
    return response;
  };
  const http = {
    fetchImpl,
    baseUrl: () => "https://cloud.invalid/api",
    token: () => "fake-token",
    csrf: () => "fake-csrf",
    headers: () => ({ era: "era-fake", epoch: "1" }),
  };
  const accountId = () => "fake-user";
  let urlId = 0;
  const liveUrls = new Set<string>();
  const createObjectURL = () => {
    const url = `blob:catalog-player/${++urlId}`;
    liveUrls.add(url);
    return url;
  };
  const revokeObjectURL = vi.fn((url: string) => { liveUrls.delete(url); });
  const pendingReads = new Set<() => void>();
  const direct = {
    ...server.directPort,
    read: vi.fn<typeof server.directPort.read>(async (ref, options) => {
      if (!streaming) return server.directPort.read(ref, options);
      const signal = options?.signal;
      // El proveedor simulado mantiene la lectura suscrita hasta que se cancele.
      return new Promise((_, reject) => {
        const cancel = () => {
          signal?.removeEventListener("abort", cancel);
          pendingReads.delete(cancel);
          reject(new DOMException("Lectura cancelada", "AbortError"));
        };
        if (signal?.aborted) cancel();
        else {
          pendingReads.add(cancel);
          signal?.addEventListener("abort", cancel, { once: true });
        }
      });
    }),
  };
  const createSink = () => {
    const url = createObjectURL();
    return { url, append: vi.fn(async () => {}), end: vi.fn(), fail: vi.fn(), close: () => revokeObjectURL(url) };
  };
  const media = createCatalogMediaClient({
    ...http, accountId, direct, createObjectURL, revokeObjectURL, createSink,
    mseSupported: () => streaming,
  });
  const leases = new Map<string, Awaited<ReturnType<typeof media.acquireStream>>>();
  const session = createCatalogPlaybackSession({
    api: createCatalogCommandsApi(http), accountId, consumerId: "player-test",
    resolveSet: async () => { throw new Error("No se esperaba una consulta de reproducción"); },
    resolveFile: async () => { throw new Error("Se esperaba un archivo en el DTO residente"); },
    async acquireSource(fileId) {
      const lease = await media.acquireStream(fileId, "player");
      leases.set(fileId, lease);
      return lease;
    },
  });

  const audio = document.createElement("audio");
  const playedSources: string[] = [];
  let paused = true;
  Object.defineProperty(audio, "paused", { get: () => paused });
  vi.spyOn(audio, "load").mockImplementation(() => {});
  vi.spyOn(audio, "play").mockImplementation(async () => {
    playedSources.push(audio.getAttribute("src") ?? "");
    paused = false;
    audio.dispatchEvent(new Event("play"));
  });
  vi.spyOn(audio, "pause").mockImplementation(() => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  });
  vi.stubGlobal("Audio", function () { return audio; });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const playbackEvents = vi.fn();
  const unsubscribe = session.onEvent(playbackEvents);
  let player!: ReturnType<typeof useAudio>;
  function Player() {
    player = useAudio();
    const { play } = player;
    // El adaptador de Gallery entrega la URL al motor al recibir el evento «play».
    useEffect(() => session.onEvent((event) => {
      const { source } = session.getSnapshot();
      if (event.kind === "play" && event.beatId && source) play(event.beatId, [source.url]);
    }), [play]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  let pending: Promise<void> | undefined;
  cleanup = async () => {
    respondToAccess.resolve();
    await act(async () => { await pending; });
    await act(async () => { root.unmount(); });
    unsubscribe();
    await session.teardown();
    media.teardown();
    for (const cancel of pendingReads) cancel();
    await Promise.allSettled([...leases.values()].map(({ stream }) => stream));
  };
  await act(async () => { root.render(createElement(Player)); });

  const target = (beat: typeof a) => ({ beatId: beat.id, version: beat.version, fileId: beat.playback!.fileId });
  async function startA() {
    await act(async () => {
      pending = session.play(target(a));
      await accessRequested.promise;
    });
    expect(session.getSnapshot().status).toBe("loading");
    expect(leases.has(target(a).fileId)).toBe(false);
  }
  async function deliverA() {
    await act(async () => {
      respondToAccess.resolve();
      await pending;
    });
  }
  function expectAReleased(active: number) {
    const lease = leases.get(target(a).fileId);
    if (lease) {
      expect.soft(media.refcount(lease.cacheKey), "referencias al lease tardío de A").toBe(0);
      expect.soft(revokeObjectURL, "URL tardía de A").toHaveBeenCalledWith(lease.url);
      expect.soft(playedSources).not.toContain(lease.url);
    }
    expect.soft(liveUrls.size, "URLs de objeto activas").toBe(active);
    expect.soft(media.metrics).toMatchObject({ leasesActive: active, urlsAlive: active });
    expect.soft(playbackEvents).not.toHaveBeenCalledWith({ kind: "play", beatId: a.id });
  }
  return {
    a, b, audio, session, media, pendingReads, revokeObjectURL, startA, deliverA, expectAReleased,
    get player() { return player; },
    async playB() { await act(async () => { await session.play(target(b)); }); },
    async pause() {
      await act(async () => {
        session.cancelPendingPlay(!audio.paused);
        player.togglePause();
      });
    },
    async logout() {
      await act(async () => {
        player.releaseFile();
        await session.teardown();
        media.teardown();
      });
    },
  };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  try { await cleanup?.(); }
  finally {
    cleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("Player del catálogo: acceso tardío de A", () => {
  it("conserva la fuente de B cuando se selecciona mientras A espera acceso", async () => {
    const h = await setup();
    await h.startA();
    await h.playB();
    const bSource = h.session.getSnapshot().source;
    expect(bSource?.url).toBeTruthy();
    expect(h.audio.getAttribute("src")).toBe(bSource?.url);
    await h.deliverA();

    expect.soft(h.session.getSnapshot()).toMatchObject({ current: { beatId: h.b.id }, source: bSource, status: "playing" });
    expect.soft(h.audio.getAttribute("src")).toBe(bSource?.url);
    expect.soft(h.player.state).toMatchObject({ playingId: h.b.id, isPlaying: true });
    expect.soft(h.media.refcount(bSource!.cacheKey)).toBe(1);
    expect.soft(h.revokeObjectURL).not.toHaveBeenCalledWith(bSource!.url);
    h.expectAReleased(1);
  });

  it("mantiene B en pausa si se pulsa Pausa mientras A espera acceso", async () => {
    const h = await setup();
    await h.playB();
    const bSource = h.audio.getAttribute("src");
    expect(bSource).toBeTruthy();
    expect(h.player.state).toMatchObject({ playingId: h.b.id, isPlaying: true });
    await h.startA();
    await h.pause();
    expect(h.player.state).toMatchObject({ playingId: h.b.id, isPlaying: false });
    await h.deliverA();

    expect.soft(h.session.getSnapshot().current?.beatId).toBe(h.b.id);
    expect.soft(h.audio.getAttribute("src")).toBe(bSource);
    expect.soft(h.player.state).toMatchObject({ playingId: h.b.id, isPlaying: false });
    h.expectAReleased(1);
  });

  it("mantiene B sonando mientras espera A y solo lo sustituye al llegar el lease vigente", async () => {
    const h = await setup();
    await h.playB();
    const bSource = h.session.getSnapshot().source;
    await h.startA();
    expect(h.audio.getAttribute("src")).toBe(bSource?.url);
    expect(h.player.state).toMatchObject({ playingId: h.b.id, isPlaying: true });
    expect(h.revokeObjectURL).not.toHaveBeenCalled();

    await h.deliverA();
    expect(h.player.state).toMatchObject({ playingId: h.a.id, isPlaying: true });
    expect(h.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(bSource!.url);
  });

  it("mantiene el Player vacío tras el cierre de sesión aunque llegue A", async () => {
    const h = await setup();
    await h.startA();
    await h.logout();
    expect(h.session.getSnapshot()).toMatchObject({ status: "idle", current: null, source: null });
    await h.deliverA();

    expect(h.session.getSnapshot()).toMatchObject({ status: "idle", current: null, source: null });
    expect(h.audio.hasAttribute("src")).toBe(false);
    expect(h.player.state).toMatchObject({ playingId: null, isPlaying: false });
  });

  it("libera el lease tardío de descarga completa tras el cierre de sesión", async () => {
    const h = await setup();
    await h.startA();
    await h.logout();
    await h.deliverA();

    h.expectAReleased(0);
  });

  it("cierra la URL y la suscripción de lectura del stream tardío tras el cierre de sesión", async () => {
    const h = await setup({ streaming: true });
    await h.startA();
    await h.logout();
    await h.deliverA();

    expect.soft(h.pendingReads.size, "suscripciones de lectura del stream de A").toBe(0);
    expect.soft(h.audio.hasAttribute("src")).toBe(false);
    h.expectAReleased(0);
  });
});
