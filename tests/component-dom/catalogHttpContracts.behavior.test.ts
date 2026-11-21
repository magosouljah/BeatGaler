// @vitest-environment jsdom
// Piloto F1 — contratos HTTP del catálogo Web, probados por comportamiento (peticiones emitidas, resultados y errores).
//  1. Comandos de reproducción (rondas Shuffle y vecinos) a través de createCatalogServices → sesión de reproducción.
//     Deben cumplir el mismo contrato de transporte que el resto de clientes del catálogo: timeout, error de red tipado
//     (CatalogNetworkError) y 401 → UNAUTHENTICATED. Cabeceras, cuerpo e idempotencia en el cuerpo se conservan.
//  2. Reintento CSRF compuesto: los clientes usan el `fetch` global, que main.tsx sustituye por el coordinador CSRF;
//     un 403 CSRF_REQUIRED se repite UNA vez con el token vigente y la misma petición (cuerpo, Idempotency-Key, If-Match, era/época).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogServices } from "../../src/features/library/catalog/catalogLibraryProvider";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { createWebCsrfCoordinatedFetch } from "../../src/features/auth/webCsrfFetchCoordinator";
import { WEB_CSRF_SESSION_KEY } from "../../src/features/auth/webSessionBootstrap";

const BASE = "/beatgaler-api";
const QUERY = { filters: { state: "ACTIVE" as const, q: "", includeTags: [], excludeTags: [], includeMode: "any" as const }, sort: "manual" as const, revision: "10" };

type Seen = { method: string; url: string; headers: Record<string, string>; body: string | undefined; credentials: RequestCredentials | undefined; hasSignal: boolean };
type Handler = (req: Seen, init: RequestInit | undefined) => Promise<Response> | Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const headersOf = (init?: RequestInit) => Object.fromEntries(new Headers(init?.headers).entries());

function router(routes: Array<[RegExp, Handler]>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = { method: String(init?.method ?? "GET"), url: String(input), headers: headersOf(init), body: init?.body as string | undefined, credentials: init?.credentials, hasSignal: Boolean(init?.signal) };
    seen.push(req);
    const hit = routes.find(([re]) => re.test(`${req.method} ${req.url}`));
    if (!hit) return json(404, { code: "NO_ROUTE", error: `${req.method} ${req.url}` });
    return hit[1](req, init);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const querySetReady = (): Handler => () => json(201, { setId: "set-1", status: "READY", scope: "ACTIVE", baseRevision: "10", memberCount: 3, checkpointSeq: 1, predicateHash: "h", errorCode: null });
const beatWithoutPlayback = (): Handler => () => json(200, { beatId: "b-2", version: "4", playback: null });

function services(fetchImpl: typeof fetch | undefined) {
  return createCatalogServices({ api: {} as never, accountId: "acc-1", context: { authority_era: "era-1", authority_epoch: "7" }, fetchImpl, baseUrl: () => BASE, token: () => "tok-1", csrf: () => "csrf-session", direct: null, prefixCache: null, artworkCache: null, prefixSyncDelayMs: null, directPreconnectDelayMs: null });
}

const live: Array<{ teardown(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.teardown().catch(() => {});
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("comandos de reproducción (createCatalogServices → sesión)", () => {
  it("vecino: GET con parámetros, sin CSRF/era/Content-Type, con bearer y cookies", async () => {
    const r = router([
      [/^POST .*\/catalog\/v1\/query-sets$/, querySetReady()],
      [/^GET .*\/query-sets\/set-1\/neighbor\?/, () => json(200, { beatId: "b-2", version: "4", member: true, total: 3 })],
      [/^GET .*\/catalog\/v1\/beats\/b-2$/, beatWithoutPlayback()],
    ]);
    const s = services(r.fetchImpl); live.push(s);
    await s.playback.setQuery(QUERY);
    await expect(s.playback.next()).resolves.toMatchObject({ beatId: "b-2", version: "4" });
    const n = r.seen.find((x) => x.url.includes("/neighbor"))!;
    expect(n.method).toBe("GET");
    expect(new URL(n.url, "http://x").searchParams.get("direction")).toBe("next");
    expect(new URL(n.url, "http://x").searchParams.get("sort")).toBe("manual");
    expect(n.url.startsWith(`${BASE}/catalog/v1/query-sets/set-1/neighbor?`)).toBe(true);
    expect(n.headers).toMatchObject({ accept: "application/json", authorization: "Bearer tok-1" });
    expect(n.headers["x-beatgaler-csrf"]).toBeUndefined();
    expect(n.headers["x-catalog-era"]).toBeUndefined();
    expect(n.headers["content-type"]).toBeUndefined();
    expect(n.credentials).toBe("include");
    expect(n.body).toBeUndefined();
  });

  it("ronda Shuffle: POST con el cuerpo exacto, idempotencia EN EL CUERPO (sin cabecera), CSRF y era/época", async () => {
    const r = router([
      [/^POST .*\/catalog\/v1\/query-sets$/, querySetReady()],
      [/^POST .*\/playback\/rounds$/, () => json(201, { roundId: "r-1", setId: "set-1", status: "READY", remaining: 3, sequence: "0" })],
      [/^POST .*\/playback\/rounds\/r-1\/next$/, () => json(200, { beatId: "b-2", version: "4", remaining: 2, sequence: "1", roundComplete: false })],
      [/^GET .*\/catalog\/v1\/beats\/b-2$/, beatWithoutPlayback()],
    ]);
    const s = services(r.fetchImpl); live.push(s);
    await s.playback.setQuery(QUERY);
    await s.playback.setShuffle(true);
    await expect(s.playback.next()).resolves.toMatchObject({ beatId: "b-2" });
    const start = r.seen.find((x) => x.url.endsWith("/playback/rounds"))!;
    expect(JSON.parse(start.body!)).toEqual({ setId: "set-1", currentBeatId: null, consumerId: s.playback.consumerId, fromRoundId: null });
    const next = r.seen.find((x) => x.url.endsWith("/playback/rounds/r-1/next"))!;
    const body = JSON.parse(next.body!);
    expect(body).toMatchObject({ roundId: "r-1", sequence: "0" });
    expect(typeof body.idempotencyKey).toBe("string");
    for (const req of [start, next]) {
      expect(req.method).toBe("POST");
      expect(req.headers).toMatchObject({ accept: "application/json", authorization: "Bearer tok-1", "content-type": "application/json", "x-catalog-era": "era-1", "x-catalog-epoch": "7", "x-beatgaler-csrf": "csrf-session" });
      expect(req.headers["idempotency-key"]).toBeUndefined();
      expect(req.credentials).toBe("include");
    }
  });

  it("409 SEQUENCE_MISMATCH conserva código y detalle: la sesión repite el sorteo con la secuencia actual", async () => {
    let calls = 0;
    const r = router([
      [/^POST .*\/catalog\/v1\/query-sets$/, querySetReady()],
      [/^POST .*\/playback\/rounds$/, () => json(201, { roundId: "r-1", setId: "set-1", status: "READY", remaining: 3, sequence: "0" })],
      [/^POST .*\/playback\/rounds\/r-1\/next$/, () => (++calls === 1 ? json(409, { code: "SEQUENCE_MISMATCH", error: "stale", detail: { current_sequence: "7" } }) : json(200, { beatId: "b-2", version: "4", remaining: 2, sequence: "8", roundComplete: false }))],
      [/^GET .*\/catalog\/v1\/beats\/b-2$/, beatWithoutPlayback()],
    ]);
    const s = services(r.fetchImpl); live.push(s);
    await s.playback.setQuery(QUERY);
    await s.playback.setShuffle(true);
    await expect(s.playback.next()).resolves.toMatchObject({ beatId: "b-2" });
    const nexts = r.seen.filter((x) => x.url.endsWith("/next")).map((x) => JSON.parse(x.body!).sequence);
    expect(nexts).toEqual(["0", "7"]);
  });

  it("un 401 se traduce a UNAUTHENTICATED, igual que en el resto de clientes del catálogo", async () => {
    const r = router([
      [/^POST .*\/catalog\/v1\/query-sets$/, querySetReady()],
      [/^GET .*\/neighbor\?/, () => json(401, { error: "session expired" })],
    ]);
    const s = services(r.fetchImpl); live.push(s);
    await s.playback.setQuery(QUERY);
    const error = await s.playback.next().catch((e) => e);
    expect(error).toBeInstanceOf(CatalogApiError);
    expect(error).toMatchObject({ status: 401, code: "UNAUTHENTICATED", message: "session expired" });
  });

  it("un fallo de red se traduce a CatalogNetworkError (no un TypeError suelto)", async () => {
    const r = router([
      [/^POST .*\/catalog\/v1\/query-sets$/, querySetReady()],
      [/^GET .*\/neighbor\?/, () => { throw new TypeError("Failed to fetch"); }],
    ]);
    const s = services(r.fetchImpl); live.push(s);
    await s.playback.setQuery(QUERY);
    const error = await s.playback.next().catch((e) => e);
    expect(error).toMatchObject({ name: "CatalogNetworkError", message: "Could not reach BeatGaler Cloud." });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
  });

  it("una petición colgada termina a los 20 s con CatalogNetworkError (antes Next/Shuffle podían quedarse esperando para siempre)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = router([
      [/^POST .*\/catalog\/v1\/query-sets$/, querySetReady()],
      [/^GET .*\/neighbor\?/, (_req, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      })],
    ]);
    const s = services(r.fetchImpl); live.push(s);
    await s.playback.setQuery(QUERY);
    let settled: unknown = "pending";
    void s.playback.next().then((v) => { settled = v; }, (e) => { settled = e; });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toMatchObject({ name: "CatalogNetworkError" });
  });
});

describe("reintento CSRF compuesto con el fetch global coordinado (main.tsx)", () => {
  let cookie = "";
  beforeEach(() => {
    window.sessionStorage.clear();
    cookie = "__Host-beatgaler_csrf=csrf-old";
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "csrf-old");
    Object.defineProperty(document, "cookie", { configurable: true, get: () => cookie });
  });
  afterEach(() => { delete (document as unknown as { cookie?: string }).cookie; });

  function coordinated(respond: (attempt: number, req: Seen) => Response) {
    const attempts: Seen[] = [];
    const delegate = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req: Seen = { method: String(init?.method ?? "GET"), url: String(input), headers: headersOf(init), body: init?.body as string | undefined, credentials: init?.credentials, hasSignal: Boolean(init?.signal) };
      attempts.push(req);
      return respond(attempts.length, req);
    }) as typeof fetch;
    vi.stubGlobal("fetch", createWebCsrfCoordinatedFetch(delegate)); // los clientes sin fetchImpl usan este fetch, como en producción
    return attempts;
  }
  const rotateThen = (ok: Response) => (attempt: number) => {
    if (attempt === 1) { cookie = "__Host-beatgaler_csrf=csrf-new"; return json(403, { code: "CSRF_REQUIRED", error: "csrf" }); }
    return ok;
  };

  it("PATCH de metadatos: un CSRF_REQUIRED se repite una vez con el token nuevo y la MISMA petición", async () => {
    const attempts = coordinated(rotateThen(json(200, { beatId: "b-1", version: "5", applied: true })));
    const commands = createCatalogCommandsApi({ baseUrl: () => BASE, token: () => "tok-1", headers: () => ({ era: "era-1", epoch: "7" }) });
    await expect(commands.patchBeat("b-1", { expectedVersion: "4", patch: { name: "Nuevo" }, idempotencyKey: "idem-1", ifMatch: "\"4\"" })).resolves.toMatchObject({ version: "5" });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.headers["x-beatgaler-csrf"])).toEqual(["csrf-old", "csrf-new"]);
    for (const k of ["idempotency-key", "if-match", "x-catalog-era", "x-catalog-epoch", "authorization", "content-type"]) expect(attempts[1].headers[k]).toBe(attempts[0].headers[k]);
    expect(attempts[1].headers["idempotency-key"]).toBe("idem-1");
    expect(attempts[1].body).toBe(attempts[0].body);
    expect(attempts[1].url).toBe(attempts[0].url);
  });

  it("transferencia (POST con Idempotency-Key en cabecera): mismo reintento único", async () => {
    const attempts = coordinated(rotateThen(json(201, { operationId: "op-1", status: "PENDING" })));
    const transfer = createCatalogTransfer({ baseUrl: () => BASE, token: () => "tok-1", headers: () => ({ era: "era-1", epoch: "7" }), direct: null });
    await transfer.createOperation({ kind: "IMPORT" } as never, { idempotencyKey: "idem-op" });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.headers["idempotency-key"])).toEqual(["idem-op", "idem-op"]);
    expect(attempts[1].headers["x-beatgaler-csrf"]).toBe("csrf-new");
  });

  it("comando de reproducción sin fetchImpl: usa el fetch coordinado y también se repite una vez", async () => {
    const attempts = coordinated((attempt, req) => {
      if (req.url.endsWith("/query-sets")) return json(201, { setId: "set-1", status: "READY", scope: "ACTIVE", baseRevision: "10", memberCount: 3, checkpointSeq: 1, predicateHash: "h", errorCode: null });
      if (req.url.endsWith("/playback/rounds")) return attempts.filter((a) => a.url.endsWith("/playback/rounds")).length === 1 ? (cookie = "__Host-beatgaler_csrf=csrf-new", json(403, { code: "CSRF_REQUIRED" })) : json(201, { roundId: "r-1", setId: "set-1", status: "READY", remaining: 3, sequence: "0" });
      if (req.url.endsWith("/playback/rounds/r-1/next")) return json(200, { beatId: "b-2", version: "4", remaining: 2, sequence: "1", roundComplete: false });
      if (req.url.endsWith("/catalog/v1/beats/b-2")) return json(200, { beatId: "b-2", version: "4", playback: null });
      return json(404, { code: "NO_ROUTE" });
    });
    const s = services(undefined); live.push(s);
    await s.playback.setQuery(QUERY);
    await s.playback.setShuffle(true);
    await s.playback.next();
    const rounds = attempts.filter((a) => a.url.endsWith("/playback/rounds"));
    expect(rounds).toHaveLength(2);
    expect(rounds[1].body).toBe(rounds[0].body);
    expect(rounds[1].headers["x-beatgaler-csrf"]).toBe("csrf-new");
  });

  it("no repite métodos seguros ni otros 403: el error llega tipado al llamador", async () => {
    const attempts = coordinated((_attempt, req) => json(403, { code: req.method === "GET" ? "CSRF_REQUIRED" : "FORBIDDEN", error: "no" }));
    const commands = createCatalogCommandsApi({ baseUrl: () => BASE, token: () => "tok-1", headers: () => ({ era: "era-1", epoch: "7" }) });
    await expect(commands.getBeat("b-1")).rejects.toMatchObject({ status: 403, code: "CSRF_REQUIRED" });
    await expect(commands.trashBeats([{ beatId: "b-1", expectedVersion: "4" }] as never, "idem-t")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(attempts).toHaveLength(2);
  });
});
