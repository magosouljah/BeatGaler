import { describe, expect, it, vi } from "vitest";
import { linkPlayback } from "../../src/features/library/catalog/catalogPlaybackLink";
import { createCatalogPlaybackSession } from "../../src/features/library/catalog/catalogPlaybackSession";

function makeSession() {
  const release = vi.fn();
  const session = createCatalogPlaybackSession({
    api: {
      startRound: vi.fn(),
      nextInRound: vi.fn(),
      consumeInRound: vi.fn(),
      releaseRound: vi.fn(),
      neighbor: vi.fn(),
    },
    resolveSet: vi.fn(),
    resolveFile: async (beatId) => ({ fileId: beatId, version: "1" }),
    acquireSource: async (fileId) => ({ url: `blob:${fileId}`, cacheKey: fileId, bytes: 1, release }),
    accountId: () => "account",
  });
  return { session, release };
}

const first = { beatId: "first", fileId: null, version: null };
const second = { beatId: "second", fileId: null, version: null };
const third = { beatId: "third", fileId: null, version: null };

function setup() {
  const { session, release } = makeSession();
  const togglePause = vi.fn();
  let playingId: string | null = null;
  const engine = {
    state: { endedSeq: 4, progress: 0, isPlaying: false },
    play: vi.fn((beatId: string, _urls: string[]) => {
      if (playingId === beatId) togglePause();
      playingId = beatId;
    }),
    seek: vi.fn(),
    togglePause,
  };
  const dom = { audioPaused: vi.fn<() => boolean | null>(() => null) };
  const onFailure = vi.fn();
  const link = linkPlayback(session, () => engine, dom);
  const update = (patch: Partial<typeof engine.state> = {}) => {
    engine.state = { ...engine.state, ...patch };
    link.onEngineState(engine.state, onFailure);
  };
  return { session, release, engine, dom, link, update };
}

describe("enlace de reproducción del catálogo", () => {
  it("envía al motor el ID y la URL arrendada al recibir play", async () => {
    const { session, engine } = setup();

    await session.play(first);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith("first", ["blob:first"]);
  });

  it("avanza una sola vez cuando cambia endedSeq", async () => {
    const { session, engine, update } = setup();
    await session.play(first);
    session.enqueue(second);
    session.enqueue(third);

    update(); // El contador inicial ya está visto.
    expect(session.getSnapshot().queue).toEqual([second, third]);
    update({ endedSeq: 5 });
    update({ endedSeq: 5 });
    expect(session.getSnapshot().queue).toEqual([third]);

    await vi.waitFor(() => {
      expect(engine.play.mock.calls).toEqual([["first", ["blob:first"]], ["second", ["blob:second"]]]);
      expect(session.getSnapshot().status).toBe("playing");
    });
  });

  it("acumula el progreso inferior a 0,01 y propaga el retorno a cero", () => {
    const { session, update } = setup();

    update({ progress: 0.005 });
    expect(session.getSnapshot().progress).toBe(0);
    update({ progress: 0.01 });
    expect(session.getSnapshot().progress).toBe(0.01);
    update({ progress: 0.015 });
    expect(session.getSnapshot().progress).toBe(0.01);
    update({ progress: 0 });
    expect(session.getSnapshot().progress).toBe(0);
  });

  it("busca el inicio en replay sin reanudar cuando el DOM devuelve null (B4)", async () => {
    const { session, engine, dom, update } = setup();
    await session.play(first);
    session.setRepeat("one");

    update({ endedSeq: 5 });

    expect(engine.seek).toHaveBeenCalledExactlyOnceWith(0);
    expect(dom.audioPaused).toHaveBeenCalledTimes(1);
    expect(engine.togglePause).not.toHaveBeenCalled();
  });

  it("delega la repetición de un beat al motor, que alterna pausa (D1)", async () => {
    const { session, engine } = setup();
    await session.play(first);
    session.enqueue(first);

    await session.next();

    expect(engine.play.mock.calls).toEqual([["first", ["blob:first"]], ["first", ["blob:first"]]]);
    expect(engine.togglePause).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().status).toBe("playing");
  });

  it("mantiene el status de la sesión al pausar y retiene el lease si el motor pierde el medio (D2/B3)", async () => {
    const { session, release, update } = setup();
    await session.play(first);
    update({ isPlaying: true, progress: 0.5 });

    update({ isPlaying: false });
    expect(session.getSnapshot().status).toBe("playing");
    update({ progress: 0 });
    expect(session.getSnapshot()).toMatchObject({ status: "playing", source: { url: "blob:first" }, progress: 0 });
    expect(release).not.toHaveBeenCalled();

    await session.teardown();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cambia la suscripción de sesión conservando el último progreso publicado y limpia al desmontar", async () => {
    const { session, engine, link, update } = setup();
    const next = makeSession().session;
    update({ progress: 0.5 });
    update({ progress: 0.495 });

    link.setSession(next);
    update();
    expect(next.getSnapshot().progress).toBe(0);
    await next.play(second);
    await session.play(first);
    expect(engine.play).toHaveBeenCalledExactlyOnceWith("second", ["blob:second"]);

    link.dispose();
    await next.play(first);
    expect(engine.play).toHaveBeenCalledTimes(1);
  });
});
