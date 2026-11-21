// @vitest-environment jsdom
// Piloto F1 — caracterización del transporte HTTP de los cuatro clientes del catálogo (catalogApi, catalogCommandsApi,
// catalogMediaClient, catalogTransfer). Fija el comportamiento ACTUAL antes de concentrar su núcleo común:
// timeout por cliente, abort del llamador, error de red tipado, traducción de errores, cabeceras por política,
// limpieza de temporizadores/listeners y las particularidades de cada uno (retry-after, métrica 403, JSON estricto).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogApiError, createCatalogApi } from "../../src/features/library/catalog/catalogApi";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";

type Seen = { method: string; url: string; headers: Record<string, string>; body: string | undefined; credentials: RequestCredentials | undefined };
type Respond = (req: Seen, init: RequestInit | undefined) => Promise<Response> | Response;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const hang: Respond = (_req, init) => new Promise<Response>((_r, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true }); });

function fake(respond: Respond) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = { method: String(init?.method ?? "GET"), url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body as string | undefined, credentials: init?.credentials };
    seen.push(req);
    return respond(req, init);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const common = (fetchImpl: typeof fetch) => ({ fetchImpl, baseUrl: () => "https://cloud.test/api", token: () => "tok", csrf: () => "csrf-1" });
const eraHeaders = () => ({ era: "era-1", epoch: "7" });

interface ClientCase {
  name: string;
  timeoutMs: number;
  postEra: boolean;
  postContentType: boolean;
  okBody: unknown;
  get?: (f: typeof fetch, signal?: AbortSignal) => Promise<unknown>;
  post: (f: typeof fetch, signal?: AbortSignal) => Promise<unknown>;
}

const CASES: ClientCase[] = [
  { name: "catalogApi", timeoutMs: 20_000, postEra: false, postContentType: true, okBody: { created: false, context: {} },
    get: (f, signal) => createCatalogApi(common(f)).context(signal),
    post: (f, signal) => createCatalogApi(common(f)).provision(signal) },
  { name: "catalogCommandsApi", timeoutMs: 20_000, postEra: true, postContentType: true, okBody: { results: [] },
    get: (f, signal) => createCatalogCommandsApi({ ...common(f), headers: eraHeaders }).getBeat("b-1", signal),
    post: (f, signal) => createCatalogCommandsApi({ ...common(f), headers: eraHeaders }).trashBeats([], "idem-1", signal) },
  { name: "catalogMediaClient", timeoutMs: 60_000, postEra: true, postContentType: false, okBody: { fileId: "f-1", ttlMs: 60_000, parts: [] },
    post: (f, signal) => createCatalogMediaClient({ ...common(f), headers: eraHeaders, accountId: () => "acc", direct: null, prefixCache: null, artworkCache: null }).access("f-1", { signal }) },
  { name: "catalogTransfer", timeoutMs: 20_000, postEra: true, postContentType: true, okBody: { operationId: "op-1" },
    get: (f, signal) => createCatalogTransfer({ ...common(f), headers: eraHeaders, direct: null }).getOperation("op-1", signal),
    post: (f, signal) => createCatalogTransfer({ ...common(f), headers: eraHeaders, direct: null }).createOperation({ kind: "IMPORT" } as never, { idempotencyKey: "idem-1", signal }) },
];

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

describe.each(CASES)("$name — transporte HTTP", (c) => {
  it("POST: bearer, cookies, CSRF y política de era/época y Content-Type del cliente; temporizador liberado al terminar", async () => {
    const r = fake(() => json(200, c.okBody));
    await c.post(r.fetchImpl);
    const req = r.seen[0];
    expect(req.method).toBe("POST");
    expect(req.url.startsWith("https://cloud.test/api/catalog/v1/")).toBe(true);
    expect(req.headers).toMatchObject({ accept: "application/json", authorization: "Bearer tok", "x-beatgaler-csrf": "csrf-1" });
    expect(req.credentials).toBe("include");
    expect(req.headers["x-catalog-era"]).toBe(c.postEra ? "era-1" : undefined);
    expect(req.headers["x-catalog-epoch"]).toBe(c.postEra ? "7" : undefined);
    expect(req.headers["content-type"]).toBe(c.postContentType ? "application/json" : undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.runIf(Boolean(c.get))("GET: sin CSRF, era/época ni Content-Type", async () => {
    const r = fake(() => json(200, c.okBody));
    await c.get!(r.fetchImpl);
    const req = r.seen[0];
    expect(req.method).toBe("GET");
    expect(req.headers).toMatchObject({ accept: "application/json", authorization: "Bearer tok" });
    for (const k of ["x-beatgaler-csrf", "x-catalog-era", "x-catalog-epoch", "content-type"]) expect(req.headers[k]).toBeUndefined();
    expect(req.body).toBeUndefined();
  });

  it(`una petición colgada termina al cumplirse su timeout con CatalogNetworkError`, async () => {
    const r = fake(hang);
    let settled: unknown = "pending";
    void c.post(r.fetchImpl).then((v) => { settled = v; }, (e) => { settled = e; });
    await vi.advanceTimersByTimeAsync(c.timeoutMs - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toMatchObject({ name: "CatalogNetworkError", message: "Could not reach BeatGaler Cloud." });
    expect((settled as { cause?: { name?: string } }).cause?.name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("el abort del llamador se propaga tal cual (no se disfraza de error de red) y libera el temporizador", async () => {
    const r = fake(hang);
    const controller = new AbortController();
    const pending = c.post(r.fetchImpl, controller.signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un fallo de red se traduce a CatalogNetworkError con la causa original", async () => {
    const r = fake(() => { throw new TypeError("Failed to fetch"); });
    const error = await c.post(r.fetchImpl).catch((e) => e);
    expect(error).toMatchObject({ name: "CatalogNetworkError", message: "Could not reach BeatGaler Cloud." });
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("errores HTTP: 401 sin código → UNAUTHENTICATED; el código, mensaje y detalle del servidor se conservan", async () => {
    const e401 = await c.post(fake(() => json(401, {})).fetchImpl).catch((e) => e);
    expect(e401).toBeInstanceOf(CatalogApiError);
    expect(e401).toMatchObject({ status: 401, code: "UNAUTHENTICATED", message: "Galer Cloud HTTP 401", detail: {} });
    const e500 = await c.post(fake(() => new Response("not json", { status: 500 })).fetchImpl).catch((e) => e);
    expect(e500).toMatchObject({ status: 500, code: "HTTP_500", message: "Galer Cloud HTTP 500" });
    const e409 = await c.post(fake(() => json(409, { code: "VERSION_CONFLICT", error: "stale", detail: { current: "9" } })).fetchImpl).catch((e) => e);
    expect(e409).toMatchObject({ status: 409, code: "VERSION_CONFLICT", message: "stale", detail: { current: "9" } });
  });
});

describe("particularidades por cliente (se conservan)", () => {
  it("catalogApi: un 200 con JSON inválido devuelve {}", async () => {
    await expect(createCatalogApi(common(fake(() => new Response("<html>", { status: 200 })).fetchImpl)).context()).resolves.toEqual({});
  });
  it("catalogCommandsApi: un 200 con JSON inválido devuelve cuerpo {}", async () => {
    await expect(createCatalogCommandsApi({ ...common(fake(() => new Response("<html>", { status: 200 })).fetchImpl), headers: eraHeaders }).getBeat("b-1")).resolves.toEqual({});
  });
  it("catalogMediaClient: un 200 con JSON inválido es un error (estricto) y un 403 cuenta como denegado", async () => {
    const bad = createCatalogMediaClient({ ...common(fake(() => new Response("<html>", { status: 200 })).fetchImpl), headers: eraHeaders, accountId: () => "acc", direct: null, prefixCache: null, artworkCache: null });
    const error = await bad.access("f-1").catch((e) => e);
    expect(error).toBeInstanceOf(SyntaxError);
    const denied = createCatalogMediaClient({ ...common(fake(() => json(403, { code: "FILE_DENIED" })).fetchImpl), headers: eraHeaders, accountId: () => "acc", direct: null, prefixCache: null, artworkCache: null });
    await expect(denied.access("f-1")).rejects.toMatchObject({ status: 403, code: "FILE_DENIED" });
    expect(denied.metrics.denied).toBe(1);
  });
  it("catalogTransfer: Retry-After se expone como detail.retry_after_ms salvo que el servidor ya lo envíe", async () => {
    const t = (r: Response) => createCatalogTransfer({ ...common(fake(() => r).fetchImpl), headers: eraHeaders, direct: null });
    await expect(t(json(429, { code: "RATE_LIMITED" }, { "Retry-After": "3" })).getOperation("op-1")).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED", detail: { retry_after_ms: 3000 } });
    await expect(t(json(429, { code: "RATE_LIMITED", detail: { retry_after_ms: 1234 } }, { "Retry-After": "3" })).getOperation("op-1")).rejects.toMatchObject({ detail: { retry_after_ms: 1234 } });
  });
  it("catalogTransfer: la respuesta conserva status, cuerpo y cabeceras (createOperation devuelve el cuerpo)", async () => {
    const r = fake(() => json(201, { operationId: "op-9" }));
    await expect(createCatalogTransfer({ ...common(r.fetchImpl), headers: eraHeaders, direct: null }).createOperation({ kind: "IMPORT" } as never, { idempotencyKey: "idem-9" })).resolves.toEqual({ operationId: "op-9" });
    expect(r.seen[0].headers["idempotency-key"]).toBe("idem-9");
  });
});
