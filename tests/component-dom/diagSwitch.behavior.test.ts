import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagCache } from "../../src/features/perf/diagSwitch";
import { playTrace } from "../../src/features/playback/playTrace";

describe("D11: diagnostico apagado por defecto", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let observers: number;
  const RealObserver = globalThis.MutationObserver;

  beforeEach(() => {
    delete (globalThis as any).__BG_DIAG__;
    localStorage.clear();
    resetDiagCache();
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    observers = 0;
    globalThis.MutationObserver = class extends RealObserver {
      constructor(cb: MutationCallback) { super(cb); observers++; }
    } as typeof MutationObserver;
  });
  afterEach(() => {
    globalThis.MutationObserver = RealObserver;
    delete (globalThis as any).__BG_DIAG__;
    localStorage.clear();
    resetDiagCache();
    info.mockRestore();
  });

  it("sin interruptor: playTrace no escribe y startupTrace no crea observador", async () => {
    playTrace("X");
    vi.resetModules();
    const fresh = await import("../../src/features/perf/startupTrace");
    fresh.installStartupTrace();
    expect(info).not.toHaveBeenCalled();
    expect(observers).toBe(0);
    expect((window as any).__BEATGALER_STARTUP_TRACE__).toBeUndefined();
  });

  it("con localStorage bg:diag=1: playTrace escribe", () => {
    localStorage.setItem("bg:diag", "1");
    playTrace("X");
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('"stage":"X"');
  });

  it("con interruptor: startupTrace instala observador y lo desconecta al plazo", async () => {
    vi.useFakeTimers();
    try {
      (globalThis as any).__BG_DIAG__ = true;
      const disconnect = vi.spyOn(RealObserver.prototype, "disconnect");
      vi.resetModules();
      const fresh = await import("../../src/features/perf/startupTrace");
      fresh.installStartupTrace();
      expect(observers).toBe(1);
      expect(Array.isArray((window as any).__BEATGALER_STARTUP_TRACE__)).toBe(true);
      expect(disconnect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_001);
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
