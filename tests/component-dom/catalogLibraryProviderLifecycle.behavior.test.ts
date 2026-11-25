import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogApi } from "../../src/features/library/catalog/catalogApi";
import type { DirectPort } from "../../src/features/library/catalog/catalogDirectTypes";
import { createCatalogServices } from "../../src/features/library/catalog/catalogLibraryProvider";
import type { createMainPackCoordinator } from "../../src/features/library/catalog/catalogMainPack";
import type { PlaybackSessionOptions } from "../../src/features/library/catalog/catalogPlaybackSession";
import type { PrefixCache } from "../../src/features/library/catalog/catalogPrefixCache";

const fakes = vi.hoisted(() => ({
  main: vi.fn(),
  playback: vi.fn(),
  createQuerySet: vi.fn(),
  openMain: vi.fn(),
  disposeMain: vi.fn(),
  disposePlayback: vi.fn(),
  disposeInteraction: vi.fn(),
  disposeMedia: vi.fn(),
  disposeStore: vi.fn(),
}));

vi.mock("../../src/features/library/catalog/catalogCommandsApi", () => ({
  createCatalogCommandsApi: () => ({ createQuerySet: fakes.createQuerySet }),
}));
vi.mock("../../src/features/library/catalog/catalogMainPack", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/features/library/catalog/catalogMainPack")>(),
  createMainPackCoordinator: fakes.main,
}));
vi.mock("../../src/features/library/catalog/catalogPlaybackSession", () => ({
  createCatalogPlaybackSession: fakes.playback,
}));
vi.mock("../../src/features/library/catalog/catalogInteractionStore", () => ({
  createCatalogInteractionStore: () => ({ teardown: fakes.disposeInteraction }),
}));
vi.mock("../../src/features/library/catalog/catalogMediaClient", () => ({
  createCatalogMediaClient: () => ({ mainPack: {}, teardown: fakes.disposeMedia }),
}));
vi.mock("../../src/features/library/catalog/catalogQueryStore", () => ({
  createCatalogQueryStore: () => ({ teardown: fakes.disposeStore }),
}));

function fakeDirect() {
  return {
    ready: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    send: vi.fn(async () => { throw new Error("envío inesperado"); }),
    read: vi.fn(async () => { throw new Error("lectura inesperada"); }),
  } satisfies DirectPort;
}

function services(options: Partial<Parameters<typeof createCatalogServices>[0]> = {}) {
  return createCatalogServices({
    accountId: "account-c12",
    api: {} as CatalogApi,
    context: { authority_era: "era", authority_epoch: "1" },
    direct: null,
    prefixCache: null,
    artworkCache: null,
    ...options,
  });
}

function withMain(direct = fakeDirect()) {
  return services({
    direct,
    context: { authority_era: "era", authority_epoch: "1", capabilities: { prefixPacks: true } },
    prefixCache: {} as PrefixCache,
    prefixSyncDelayMs: 40,
    directPreconnectDelayMs: 20,
  });
}

function playbackOptions(): PlaybackSessionOptions {
  return fakes.playback.mock.calls[0][0];
}

const query = {
  filters: { state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "all" },
  sort: "name",
  revision: "1",
} satisfies Parameters<PlaybackSessionOptions["resolveSet"]>[0];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fakes.main.mockReturnValue({
    open: fakes.openMain,
    teardown: fakes.disposeMain,
  });
  fakes.playback.mockReturnValue({ teardown: fakes.disposePlayback });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  localStorage.clear();
});

describe("teardown del proveedor", () => {
  it.each(["visible", "hidden"] as const)("conserva el orden y las esperas con pestaña %s", async (visibility) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
    const order: string[] = [];
    const playbackDone = gate();
    const interactionDone = gate();
    const closeDone = gate();
    const direct = fakeDirect();
    const arm = vi.spyOn(globalThis, "setTimeout");
    const added = vi.spyOn(document, "addEventListener");
    const catalog = withMain(direct);
    const syncTimer = arm.mock.results[arm.mock.calls.findIndex(([, delay]) => delay === 40)].value;
    const preconnectTimer = arm.mock.results[arm.mock.calls.findIndex(([, delay]) => delay === 20)]?.value;
    const listener = added.mock.calls.find(([name]) => name === "visibilitychange")?.[1];

    const { resolveSet } = playbackOptions();
    fakes.createQuerySet.mockResolvedValueOnce({ status: "READY", setId: "old", memberCount: 1 });
    const cached = resolveSet(query);
    await cached;
    fakes.disposeMain.mockImplementation(() => { order.push("main"); });
    const clear = globalThis.clearTimeout;
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      order.push(timer === syncTimer ? "sync" : timer === preconnectTimer ? "preconnect" : "otro temporizador");
      clear(timer);
    });
    const remove = document.removeEventListener.bind(document);
    vi.spyOn(document, "removeEventListener").mockImplementation((name, callback, options) => {
      if (name === "visibilitychange" && callback === listener) order.push("visibility");
      remove(name, callback, options);
    });
    fakes.disposePlayback.mockImplementation(() => { order.push("playback"); return playbackDone.promise; });
    fakes.disposeInteraction.mockImplementation(() => { order.push("interaction"); return interactionDone.promise; });
    fakes.disposeMedia.mockImplementation(() => { order.push("media"); });
    fakes.disposeStore.mockImplementation(() => {
      order.push("store");
      expect(resolveSet(query)).toBe(cached);
    });
    let fresh: ReturnType<typeof resolveSet> | undefined;
    direct.close.mockImplementation(async () => {
      order.push("close");
      fakes.createQuerySet.mockResolvedValueOnce({ status: "READY", setId: "new", memberCount: 2 });
      fresh = resolveSet(query);
      await closeDone.promise;
      throw new Error("cierre fallido");
    });

    const start = ["main", "sync", visibility === "visible" ? "preconnect" : "visibility", "playback"];
    const teardown = catalog.teardown();
    let finished = false;
    void teardown.then(() => { finished = true; });
    expect(order).toEqual(start);
    playbackDone.release();
    await Promise.resolve();
    expect(order).toEqual([...start, "interaction"]);
    interactionDone.release();
    await Promise.resolve();
    expect(order).toEqual([...start, "interaction", "media", "store", "close"]);
    expect(fakes.createQuerySet).toHaveBeenCalledTimes(2);
    expect(finished).toBe(false);
    closeDone.release();
    await expect(teardown).resolves.toBeUndefined();
    expect(await fresh).toEqual({ setId: "new", memberCount: 2 });
  });
});

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("preconexión Direct", () => {
  it("espera el retardo y abre una vez", async () => {
    const direct = fakeDirect();
    const catalog = services({ direct, directPreconnectDelayMs: 20 });
    await vi.advanceTimersByTimeAsync(19);
    expect(direct.ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(direct.ready).toHaveBeenCalledExactlyOnceWith();
    await vi.advanceTimersByTimeAsync(100);
    expect(direct.ready).toHaveBeenCalledTimes(1);
    await catalog.teardown();
  });

  it("omite la apertura si el navegador está offline al vencer el plazo", async () => {
    const direct = fakeDirect();
    const catalog = services({ direct, directPreconnectDelayMs: 20 });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(direct.ready).not.toHaveBeenCalled();
    await catalog.teardown();
  });

  it("arma el plazo al hacerse visible y retira el listener", async () => {
    setVisibility("hidden");
    const direct = fakeDirect();
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const catalog = services({ direct, directPreconnectDelayMs: 20 });
    const listener = added.mock.calls.find(([name]) => name === "visibilitychange")?.[1];
    expect(listener).toBeTypeOf("function");
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(100);
    expect(direct.ready).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalledWith("visibilitychange", listener);
    setVisibility("visible");
    expect(removed).toHaveBeenCalledWith("visibilitychange", listener);
    await vi.advanceTimersByTimeAsync(19);
    expect(direct.ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(direct.ready).toHaveBeenCalledTimes(1);
    await catalog.teardown();
  });

  it.each(["visible", "hidden"] as const)("cancela la apertura al desmontar con pestaña %s", async (visibility) => {
    setVisibility(visibility);
    const direct = fakeDirect();
    const catalog = services({ direct, directPreconnectDelayMs: 20 });
    await catalog.teardown();
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(20);
    expect(direct.ready).not.toHaveBeenCalled();
    expect(direct.close).toHaveBeenCalledTimes(1);
  });
});

describe("MAIN", () => {
  const key = "beatgaler:catalog-main:v1:account-c12";
  function mainOptions(): Parameters<typeof createMainPackCoordinator>[0] {
    return fakes.main.mock.calls[0][0];
  }

  it("lee, escribe y borra la versión de la cuenta y abre tras el plazo", async () => {
    localStorage.setItem(key, "anterior");
    const catalog = withMain();
    const { knownVersion, rememberVersion } = mainOptions();
    expect(knownVersion!()).toBe("anterior");
    rememberVersion!("nueva");
    expect(localStorage.getItem(key)).toBe("nueva");
    rememberVersion!(null);
    expect(localStorage.getItem(key)).toBeNull();
    await vi.advanceTimersByTimeAsync(39);
    expect(fakes.openMain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fakes.openMain).toHaveBeenCalledTimes(1);
    await catalog.teardown();
  });

  it("tolera errores de localStorage al leer, escribir y borrar", async () => {
    const catalog = withMain();
    const { knownVersion, rememberVersion } = mainOptions();
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("sin almacenamiento"); });
    }
    expect(knownVersion!()).toBeNull();
    expect(() => rememberVersion!("nueva")).not.toThrow();
    expect(() => rememberVersion!(null)).not.toThrow();
    await catalog.teardown();
    await vi.advanceTimersByTimeAsync(40);
    expect(fakes.openMain).not.toHaveBeenCalled();
  });
});

describe("caché de conjuntos", () => {
  it("comparte el intento, reintenta tras un rechazo e invalida un éxito", async () => {
    const catalog = services();
    const { resolveSet, invalidateSet } = playbackOptions();
    fakes.createQuerySet
      .mockRejectedValueOnce(new Error("conjunto fallido"))
      .mockResolvedValueOnce({ status: "READY", setId: "s1", memberCount: 1 })
      .mockResolvedValueOnce({ status: "READY", setId: "s2", memberCount: 2 });
    const failed = resolveSet(query);
    expect(resolveSet(query)).toBe(failed);
    await expect(failed).rejects.toThrow("conjunto fallido");
    const cached = resolveSet(query);
    await expect(cached).resolves.toEqual({ setId: "s1", memberCount: 1 });
    expect(resolveSet(query)).toBe(cached);
    invalidateSet!(query);
    await expect(resolveSet(query)).resolves.toEqual({ setId: "s2", memberCount: 2 });
    expect(fakes.createQuerySet).toHaveBeenCalledTimes(3);
    await catalog.teardown();
  });
});
