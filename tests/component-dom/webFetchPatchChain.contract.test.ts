// Caracterización M7.7b: contrato combinado de los DOS parches de `window.fetch`
// (webSession.installWebCredentialedFetchBoundary + webCsrfFetchCoordinator) instalados en el
// MISMO orden que producción: webSession se evalúa al importar (interno), main.tsx llama después a
// installWebCsrfFetchCoordinator() (externo). Cadena: coordinador -> frontera de credenciales -> fetch nativo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_CSRF_SESSION_KEY } from "../../src/features/auth/webSessionBootstrap";

const CSRF_COOKIE = "__Host-beatgaler_csrf";
const REMOTE_HOST = "desktop-7l93a0j.tailabe8ff.ts.net";

type Call = { input: RequestInfo | URL; init: RequestInit | undefined };
let cookieHeader = "";
let native: ReturnType<typeof vi.fn>;
let nativeResponses: Array<() => Response>;
let originalFetch: typeof window.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const calls = (): Call[] => native.mock.calls.map(([input, init]) => ({ input, init }));
const hdr = (c: Call, name: string): string | null => new Headers(c.init?.headers).get(name);
const origin = () => window.location.origin;

async function installLikeProduction(): Promise<void> {
  vi.resetModules();
  delete (window as any).__beatgalerWebFetchBoundaryInstalled;
  window.fetch = native as unknown as typeof window.fetch;
  await import("../../src/features/auth/webSession"); // instala el parche único al importar
  const { installWebFetchBoundary } = await import("../../src/features/auth/webFetchBoundary");
  installWebFetchBoundary(); // como main.tsx, después (no-op)
}

beforeEach(async () => {
  originalFetch = window.fetch;
  window.sessionStorage.clear();
  window.localStorage.clear();
  cookieHeader = "";
  Object.defineProperty(document, "cookie", { configurable: true, get: () => cookieHeader });
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  nativeResponses = [];
  native = vi.fn(async () => (nativeResponses.shift() ?? (() => json(200, { ok: true })))());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await installLikeProduction();
});

afterEach(() => {
  delete (document as any).cookie;
  delete (window as any).__beatgalerWebFetchBoundaryInstalled;
  window.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("cadena de parches de fetch (orden de producción)", () => {
  it("POST a /beatgaler-api/ same-origin: Client web + CSRF de la cookie + credentials include", async () => {
    cookieHeader = `${CSRF_COOKIE}=csrf-A`;
    await window.fetch(`${origin()}/beatgaler-api/catalog/v1/x`, { method: "POST", body: "{}" });
    expect(native).toHaveBeenCalledTimes(1);
    const [c] = calls();
    expect(c.input).toBe(`${origin()}/beatgaler-api/catalog/v1/x`);
    expect(hdr(c, "X-BeatGaler-Client")).toBe("web");
    expect(hdr(c, "X-BeatGaler-CSRF")).toBe("csrf-A");
    expect(c.init?.credentials).toBe("include");
    expect(c.init?.method).toBe("POST");
    expect(c.init?.body).toBe("{}");
    expect(window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)).toBe("csrf-A");
  });

  it("GET same-origin: Client + credentials include, SIN CSRF aunque haya cookie", async () => {
    cookieHeader = `${CSRF_COOKIE}=csrf-A`;
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "csrf-A");
    await window.fetch(`${origin()}/beatgaler-api/plans/me`);
    const [c] = calls();
    expect(hdr(c, "X-BeatGaler-Client")).toBe("web");
    expect(hdr(c, "X-BeatGaler-CSRF")).toBeNull();
    expect(c.init?.credentials).toBe("include");
  });

  it.each(["HEAD", "OPTIONS"])("%s same-origin no recibe CSRF", async (method) => {
    cookieHeader = `${CSRF_COOKIE}=csrf-A`;
    await window.fetch(`${origin()}/beatgaler-api/x`, { method });
    expect(hdr(calls()[0], "X-BeatGaler-CSRF")).toBeNull();
    expect(hdr(calls()[0], "X-BeatGaler-Client")).toBe("web");
  });

  it.each(["PUT", "PATCH", "DELETE", "post"])("%s same-origin recibe CSRF (método normalizado a mayúsculas)", async (method) => {
    cookieHeader = `${CSRF_COOKIE}=csrf-A`;
    await window.fetch(`${origin()}/beatgaler-api/x`, { method });
    expect(hdr(calls()[0], "X-BeatGaler-CSRF")).toBe("csrf-A");
  });

  it("sin cookie, el CSRF de sessionStorage lo pone la frontera interna", async () => {
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "csrf-S");
    await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
    expect(hdr(calls()[0], "X-BeatGaler-CSRF")).toBe("csrf-S");
  });

  it("sin cookie ni sessionStorage: POST sale sin CSRF pero con Client y credentials", async () => {
    await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
    const [c] = calls();
    expect(hdr(c, "X-BeatGaler-CSRF")).toBeNull();
    expect(hdr(c, "X-BeatGaler-Client")).toBe("web");
    expect(c.init?.credentials).toBe("include");
  });

  it("la cookie rota gana a una cabecera obsoleta del llamador y a sessionStorage viejo", async () => {
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "csrf-old");
    cookieHeader = `${CSRF_COOKIE}=csrf-new`;
    await window.fetch(`${origin()}/beatgaler-api/x`, {
      method: "POST",
      headers: { "X-BeatGaler-CSRF": "csrf-caller", "X-BeatGaler-Client": "otro", "X-Keep": "1" },
      credentials: "omit",
    });
    const [c] = calls();
    expect(hdr(c, "X-BeatGaler-CSRF")).toBe("csrf-new");
    expect(hdr(c, "X-BeatGaler-Client")).toBe("web");
    expect(hdr(c, "X-Keep")).toBe("1");
    expect(c.init?.credentials).toBe("include");
    expect(window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)).toBe("csrf-new");
  });

  it("URL object y Request: se tratan como API y conservan cabeceras del Request", async () => {
    cookieHeader = `${CSRF_COOKIE}=csrf-A`;
    await window.fetch(new URL(`${origin()}/beatgaler-api/u`), { method: "POST" });
    expect(hdr(calls()[0], "X-BeatGaler-CSRF")).toBe("csrf-A");
    expect(calls()[0].init?.credentials).toBe("include");

    const req = new Request(`${origin()}/beatgaler-api/r`, { method: "POST", headers: { "X-From-Request": "yes" }, body: "{}" });
    await window.fetch(req);
    const c = calls()[1];
    expect(c.input).toBe(req);
    expect(hdr(c, "X-From-Request")).toBe("yes");
    expect(hdr(c, "X-BeatGaler-CSRF")).toBe("csrf-A");
    expect(hdr(c, "X-BeatGaler-Client")).toBe("web");
    expect(c.init?.credentials).toBe("include");
  });

  describe("otros orígenes y rutas: ni CSRF ni credenciales ni Client", () => {
    const untouched: Array<[string, string]> = [
      ["Telegram", "https://api.telegram.org/bot1/sendDocument"],
      ["tercero", "https://third.example.com/beatgaler-api/x"],
      ["subdominio engañoso", "https://localhost.evil.example/beatgaler-api/x"],
      ["https con 127.0.0.1", "https://127.0.0.1/x"],
      ["http localhost", "http://localhost:4000/x"],
      ["http otro puerto del mismo host de la página", "http://localhost:9/other"],
      ["same-origin fuera de /beatgaler-api", "/other/api"],
      ["prefijo parecido sin barra", "/beatgaler-apix/x"],
    ];
    it.each(untouched)("POST a %s pasa intacto", async (_n, url) => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "csrf-A");
      const init = { method: "POST", body: "bytes", headers: { "X-Caller": "1" } };
      await window.fetch(url, init);
      const [c] = calls();
      expect(c.input).toBe(url);
      expect(hdr(c, "X-BeatGaler-CSRF")).toBeNull();
      expect(hdr(c, "X-BeatGaler-Client")).toBeNull();
      expect(hdr(c, "X-Caller")).toBe("1");
      expect(c.init?.credentials).toBeUndefined();
      expect(c.init?.body).toBe("bytes");
    });

    it("origen que solo empieza igual que el propio (origin + '.evil.com') no recibe nada", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      await window.fetch(`${origin()}.evil.com/beatgaler-api/x`, { method: "POST" });
      const [c] = calls();
      expect(hdr(c, "X-BeatGaler-CSRF")).toBeNull();
      expect(hdr(c, "X-BeatGaler-Client")).toBeNull();
      expect(c.init?.credentials).toBeUndefined();
    });

    it("GET a tercero tampoco recibe nada", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      await window.fetch("https://api.telegram.org/file/x");
      const [c] = calls();
      expect(hdr(c, "X-BeatGaler-CSRF")).toBeNull();
      expect(hdr(c, "X-BeatGaler-Client")).toBeNull();
      expect(c.init?.credentials).toBeUndefined();
    });
  });

  describe("discrepancias de filtro entre los dos parches (comportamiento ACTUAL, fijado)", () => {
    it("URL relativa '/beatgaler-api/..': el coordinador pone CSRF, la frontera NO pone Client ni credentials", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      await window.fetch("/beatgaler-api/rel", { method: "POST" });
      const [c] = calls();
      expect(hdr(c, "X-BeatGaler-CSRF")).toBe("csrf-A");
      expect(hdr(c, "X-BeatGaler-Client")).toBeNull();
      expect(c.init?.credentials).toBeUndefined();
    });

    it("http://127.0.0.1 (cualquier ruta/puerto): CSRF sí, Client y credentials no", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      await window.fetch("http://127.0.0.1:4000/auth/x", { method: "POST" });
      const [c] = calls();
      expect(hdr(c, "X-BeatGaler-CSRF")).toBe("csrf-A");
      expect(hdr(c, "X-BeatGaler-Client")).toBeNull();
      expect(c.init?.credentials).toBeUndefined();
    });

    it("host remoto tailnet (https, cualquier ruta): CSRF sí, Client y credentials no", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      await window.fetch(`https://${REMOTE_HOST}/auth/x`, { method: "POST" });
      const [c] = calls();
      expect(hdr(c, "X-BeatGaler-CSRF")).toBe("csrf-A");
      expect(hdr(c, "X-BeatGaler-Client")).toBeNull();
      expect(c.init?.credentials).toBeUndefined();
    });

    it("GET a 127.0.0.1 / host remoto: no recibe nada", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      await window.fetch("http://127.0.0.1:4000/health");
      await window.fetch(`https://${REMOTE_HOST}/health`);
      for (const c of calls()) {
        expect(hdr(c, "X-BeatGaler-CSRF")).toBeNull();
        expect(hdr(c, "X-BeatGaler-Client")).toBeNull();
        expect(c.init?.credentials).toBeUndefined();
      }
    });
  });

  describe("reintento ante 403 CSRF_REQUIRED", () => {
    it("reintenta UNA vez con el token rotado; devuelve la segunda respuesta", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-old`;
      nativeResponses = [
        () => { cookieHeader = `${CSRF_COOKIE}=csrf-new`; return json(403, { code: "CSRF_REQUIRED" }); },
        () => json(200, { ok: "second" }),
      ];
      const r = await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST", body: "{}" });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: "second" });
      expect(native).toHaveBeenCalledTimes(2);
      expect(hdr(calls()[0], "X-BeatGaler-CSRF")).toBe("csrf-old");
      expect(hdr(calls()[1], "X-BeatGaler-CSRF")).toBe("csrf-new");
      expect(calls()[1].init?.credentials).toBe("include");
      expect(hdr(calls()[1], "X-BeatGaler-Client")).toBe("web");
    });

    it("si el segundo intento también es CSRF_REQUIRED, no hay tercero y se devuelve el 403", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-old`;
      nativeResponses = [() => json(403, { code: "CSRF_REQUIRED" }), () => json(403, { code: "CSRF_REQUIRED" })];
      const r = await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
      expect(r.status).toBe(403);
      expect(native).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["403 con otro código", () => json(403, { code: "FORBIDDEN" })],
      ["403 sin cuerpo JSON", () => new Response("no", { status: 403 })],
    ])("%s: sin reintento", async (_n, make) => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      nativeResponses = [make];
      const r = await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
      expect(r.status).toBe(403);
      expect(native).toHaveBeenCalledTimes(1);
    });

    it("GET con 403 CSRF_REQUIRED no se reintenta (solo métodos no seguros)", async () => {
      nativeResponses = [() => json(403, { code: "CSRF_REQUIRED" })];
      const r = await window.fetch(`${origin()}/beatgaler-api/x`);
      expect(r.status).toBe(403);
      expect(native).toHaveBeenCalledTimes(1);
    });

    it("Request de entrada no se reproduce", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      nativeResponses = [() => json(403, { code: "CSRF_REQUIRED" })];
      const req = new Request(`${origin()}/beatgaler-api/x`, { method: "POST", body: "{}" });
      expect((await window.fetch(req)).status).toBe(403);
      expect(native).toHaveBeenCalledTimes(1);
    });

    it("body ReadableStream no se reproduce", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      nativeResponses = [() => json(403, { code: "CSRF_REQUIRED" })];
      const body = new ReadableStream();
      const r = await window.fetch(`${origin()}/beatgaler-api/y`, { method: "POST", body, duplex: "half" } as RequestInit);
      expect(r.status).toBe(403);
      expect(native).toHaveBeenCalledTimes(1);
    });

    it("el 403 CSRF_REQUIRED de un tercero no se reintenta", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      nativeResponses = [() => json(403, { code: "CSRF_REQUIRED" })];
      const r = await window.fetch("https://third.example.com/x", { method: "POST" });
      expect(r.status).toBe(403);
      expect(native).toHaveBeenCalledTimes(1);
    });
  });

  describe("401 / sesión expirada", () => {
    it.each([401, 440])("%s se entrega tal cual, sin reintento ni transformación", async (status) => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      nativeResponses = [() => json(status, { code: "SESSION_EXPIRED" })];
      const r = await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ code: "SESSION_EXPIRED" });
      expect(native).toHaveBeenCalledTimes(1);
    });

    it("403 SESSION_EXPIRED en POST: sin reintento y sin degradar", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      nativeResponses = [() => json(403, { code: "SESSION_EXPIRED" })];
      const r = await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
      expect(r.status).toBe(403);
      expect(native).toHaveBeenCalledTimes(1);
    });

    it("errores de red del fetch nativo se propagan sin reintento", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      native.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" })).rejects.toThrow("Failed to fetch");
      expect(native).toHaveBeenCalledTimes(1);
    });
  });

  describe("events/ticket", () => {
    it("403 de /events/ticket (online) se convierte en 200 degradado + evento", async () => {
      const events: unknown[] = [];
      const on = (e: Event) => events.push((e as CustomEvent).detail);
      window.addEventListener("beatgaler:event-sync-status", on);
      nativeResponses = [() => json(403, { code: "EVENT_FORBIDDEN" })];
      const r = await window.fetch(`${origin()}/beatgaler-api/events/ticket`);
      window.removeEventListener("beatgaler:event-sync-status", on);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: false, ticket: null, event_sync_status: "degraded", code: "EVENT_FORBIDDEN" });
      expect(events).toEqual([{ state: "degraded", source: "event_ticket", status: 403, code: "EVENT_FORBIDDEN" }]);
    });

    it("offline: el 403 de /events/ticket NO se degrada", async () => {
      Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
      nativeResponses = [() => json(403, { code: "X" })];
      const r = await window.fetch(`${origin()}/beatgaler-api/events/ticket`);
      expect(r.status).toBe(403);
    });

    it("/events/ticket 200 y 403 en otra ruta no se tocan", async () => {
      expect((await window.fetch(`${origin()}/beatgaler-api/events/ticket`)).status).toBe(200);
      nativeResponses = [() => json(403, { code: "X" })];
      expect((await window.fetch(`${origin()}/beatgaler-api/events/other`)).status).toBe(403);
    });

    it("/events/ticket de un tercero no se degrada", async () => {
      nativeResponses = [() => json(403, { code: "X" })];
      expect((await window.fetch("https://third.example.com/events/ticket")).status).toBe(403);
    });
  });

  describe("idempotencia de la instalación", () => {
    it("reinstalar ambos parches (mismas banderas) no apila capas ni cambia window.fetch", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-A`;
      const patched = window.fetch;
      const { installWebFetchBoundary } = await import("../../src/features/auth/webFetchBoundary");
      installWebFetchBoundary();
      installWebFetchBoundary();
      vi.resetModules();
      await import("../../src/features/auth/webSession"); // 2.ª evaluación: bandera ya puesta
      expect(window.fetch).toBe(patched);
      nativeResponses = [() => json(403, { code: "CSRF_REQUIRED" }), () => json(200, {})];
      await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
      expect(native).toHaveBeenCalledTimes(2); // 1 + 1 reintento, no más
      expect((window as any).__beatgalerWebFetchBoundaryInstalled).toBe(true);
    });
  });

  describe("orden de instalación", () => {
    it("coordinador externo: el reintento re-lee la cookie rotada y la frontera interna vuelve a añadir credentials/Client", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-old`;
      nativeResponses = [
        () => { cookieHeader = `${CSRF_COOKIE}=csrf-new`; return json(403, { code: "CSRF_REQUIRED" }); },
        () => json(200, {}),
      ];
      await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST" });
      expect(hdr(calls()[1], "X-BeatGaler-CSRF")).toBe("csrf-new");
      expect(hdr(calls()[1], "X-BeatGaler-Client")).toBe("web");
      expect(calls()[1].init?.credentials).toBe("include");
    });

    it("la cookie sincronizada por el coordinador llega a sessionStorage antes de que la frontera lea", async () => {
      window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "stale");
      cookieHeader = `${CSRF_COOKIE}=fresh`;
      await window.fetch(`${origin()}/beatgaler-api/x`, { method: "DELETE" });
      expect(hdr(calls()[0], "X-BeatGaler-CSRF")).toBe("fresh");
    });

    it("la frontera añade credentials al reintento incluso si el llamador pidió omit", async () => {
      cookieHeader = `${CSRF_COOKIE}=csrf-old`;
      nativeResponses = [() => json(403, { code: "CSRF_REQUIRED" }), () => json(200, {})];
      await window.fetch(`${origin()}/beatgaler-api/x`, { method: "POST", credentials: "omit" });
      expect(calls().map((c) => c.init?.credentials)).toEqual(["include", "include"]);
    });
  });
});
