// M7.7b: propiedades que introduce el módulo único webFetchBoundary (bandera única, Desktop solo-coordinador,
// un único nivel de envoltorio sobre el fetch nativo).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let native: ReturnType<typeof vi.fn>;
let original: typeof window.fetch;
const FLAG = "__beatgalerWebFetchBoundaryInstalled";

beforeEach(() => {
  vi.resetModules();
  original = window.fetch;
  delete (window as any)[FLAG];
  native = vi.fn(async () => new Response("{}", { status: 200 }));
  window.fetch = native as unknown as typeof window.fetch;
});
afterEach(() => {
  window.fetch = original;
  delete (window as any)[FLAG];
  vi.doUnmock("../../src/platform");
});

describe("installWebFetchBoundary", () => {
  it("web: reemplaza fetch una sola vez, una sola bandera, y una petición propia llega 1 vez al nativo con Client+credentials", async () => {
    const { installWebFetchBoundary } = await import("../../src/features/auth/webFetchBoundary");
    installWebFetchBoundary();
    const patched = window.fetch;
    expect(patched).not.toBe(native);
    installWebFetchBoundary();
    expect(window.fetch).toBe(patched);
    expect((window as any)[FLAG]).toBe(true);
    await window.fetch(`${window.location.origin}/beatgaler-api/x`);
    expect(native).toHaveBeenCalledTimes(1);
    const init = native.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("X-BeatGaler-Client")).toBe("web");
    expect(init.credentials).toBe("include");
  });

  it("web: ante CSRF_REQUIRED hay exactamente un reintento (un solo coordinador)", async () => {
    const { installWebFetchBoundary } = await import("../../src/features/auth/webFetchBoundary");
    installWebFetchBoundary();
    native.mockImplementation(async () => new Response(JSON.stringify({ code: "CSRF_REQUIRED" }), { status: 403 }));
    const res = await window.fetch(`${window.location.origin}/beatgaler-api/x`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("web: un tercero atraviesa un único envoltorio sin cabeceras ni credentials", async () => {
    const { installWebFetchBoundary } = await import("../../src/features/auth/webFetchBoundary");
    installWebFetchBoundary();
    await window.fetch("https://third.example.com/x", { method: "POST" });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0][1]).toEqual({ method: "POST" });
  });

  it("desktop: solo coordinador; no añade Client ni credentials", async () => {
    vi.doMock("../../src/platform", () => ({ platform: { kind: "desktop" } }));
    const { installWebFetchBoundary } = await import("../../src/features/auth/webFetchBoundary");
    installWebFetchBoundary();
    expect(window.fetch).not.toBe(native);
    await window.fetch(`${window.location.origin}/beatgaler-api/x`);
    expect(native).toHaveBeenCalledTimes(1);
    const init = native.mock.calls[0][1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("X-BeatGaler-Client")).toBeNull();
    expect(init?.credentials).toBeUndefined();
  });
});
