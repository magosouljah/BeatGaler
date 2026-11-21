// T08 — Cliente /catalog/v1: resolución de contexto (404 → provision una vez, RESET/QUARANTINE/401/503/offline), query string,
// cabeceras y mapeo de errores estables. Sin red: fetch inyectado.
import { describe, expect, it } from "vitest";
import { CatalogApiError, createCatalogApi } from "../../src/features/library/catalog/catalogApi";
import { chooseLibraryComposition, compositionMessage } from "../../src/features/library/catalog/catalogComposition";

type Call = { url: string; init: RequestInit };
function fakeFetch(routes: Record<string, (call: Call) => { status: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const call = { url, init: init ?? {} }; calls.push(call);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key](call) : { status: 404, body: { error: "no route", code: "NOT_FOUND" } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const ctx = { authority: "POSTGRES", user_id: "u1", vault_id: "v1", chat_id: "-1", authority_era: "e", authority_epoch: "1", revision: "1", generation_id: "g", generation_origin: "NATIVE", migration_state: "IDLE", counts: { active: 0, trash: 0, purging: 0, pending: 0 }, restore_hold: true, cleanup_enabled: false };

describe("catalogApi", () => {
  it("404 LIBRARY_NOT_PROVISIONED → POST provision una sola vez → ready; bearer + cookies; CSRF solo en POST", async () => {
    let provisioned = false;
    const f = fakeFetch({
      "/catalog/v1/context": () => (provisioned ? { status: 200, body: ctx } : { status: 404, body: { error: "np", code: "LIBRARY_NOT_PROVISIONED", detail: { provision: "POST /catalog/v1/library/provision" } } }),
      "/catalog/v1/library/provision": () => { provisioned = true; return { status: 201, body: { created: true, context: ctx } }; },
    });
    const api = createCatalogApi({ fetchImpl: f.fetchImpl, baseUrl: () => "https://cloud.invalid/beatgaler-api", token: () => "tok", csrf: () => "csrf-1" });
    const r = await api.resolveContext();
    expect(r.status).toBe("ready"); if (r.status === "ready") expect(r.provisioned).toBe(true);
    expect(f.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([["GET", "/beatgaler-api/catalog/v1/context"], ["POST", "/beatgaler-api/catalog/v1/library/provision"]]);
    const h0 = f.calls[0].init.headers as Record<string, string>; const h1 = f.calls[1].init.headers as Record<string, string>;
    expect([h0.Authorization, h0["X-BeatGaler-CSRF"], f.calls[0].init.credentials]).toEqual(["Bearer tok", undefined, "include"]);
    expect([h1.Authorization, h1["X-BeatGaler-CSRF"], h1["Content-Type"]]).toEqual(["Bearer tok", "csrf-1", "application/json"]);
    const again = await api.resolveContext();
    expect(again.status === "ready" && again.provisioned).toBe(false);
    expect(f.calls.filter((c) => c.url.includes("provision")).length).toBe(1);
  });

  it("RESET_REQUIRED / QUARANTINED / 401 / 503 / offline clasifican sin aprovisionar ni caer a LEGACY; la composición queda bloqueada con copy", async () => {
    const cases: Array<[{ status: number; body: unknown } | Error, string]> = [
      [{ status: 409, body: { error: "r", code: "LIBRARY_RESET_REQUIRED", detail: { reasons: ["LIBRARY_LEGACY"] } } }, "reset_required"],
      [{ status: 409, body: { error: "q", code: "VAULT_QUARANTINED" } }, "quarantined"],
      [{ status: 401, body: { error: "Session expired. Sign in again." } }, "unauthenticated"],
      [{ status: 503, body: { error: "u", code: "CATALOG_UNAVAILABLE", detail: { reason: "NOT_ACTIVATED" } } }, "unavailable"],
      [new TypeError("fetch failed"), "offline"],
    ];
    for (const [response, expected] of cases) {
      const f = fakeFetch({ "/catalog/v1/context": () => response, "/catalog/v1/library/provision": () => ({ status: 500, body: {} }) });
      const api = createCatalogApi({ fetchImpl: f.fetchImpl, baseUrl: () => "https://cloud.invalid", token: () => "tok" });
      const r = await api.resolveContext();
      expect(r.status).toBe(expected);
      expect(f.calls.some((c) => c.url.includes("provision"))).toBe(false);
      const comp = await chooseLibraryComposition({ enabled: true, api });
      expect(comp.mode).toBe("blocked");
      expect(compositionMessage(comp)).toBeTruthy();
    }
    const off = await chooseLibraryComposition({ enabled: false, api: createCatalogApi({ fetchImpl: fakeFetch({}).fetchImpl, baseUrl: () => "x", token: () => null }) });
    expect(off).toEqual({ mode: "legacy", reason: "flag-off" });
  });

  it("listBeats construye la query C5 (tags repetibles, cursor, edge, includeTotal) y mapea errores JSON a CatalogApiError; legacy valida el offset antes de la red", async () => {
    const f = fakeFetch({
      "/catalog/v1/beats?": (c) => (c.url.includes("cursor=stale") ? { status: 409, body: { error: "s", code: "CURSOR_STALE", detail: { current_revision: "9" } } } : { status: 200, body: { items: [], startOrdinal: 0 } }),
      "/catalog/v1/navigation/legacy": () => ({ status: 200, body: { items: [], resolution: "empty" } }),
    });
    const api = createCatalogApi({ fetchImpl: f.fetchImpl, baseUrl: () => "https://cloud.invalid", token: () => "tok" });
    await api.listBeats({ state: "TRASH", sort: "name", q: "tr ap", includeTags: ["Trap", "Dark"], excludeTags: ["demo"], includeMode: "all", limit: 240, includeTotal: true, edge: "last" });
    const u = new URL(f.calls[0].url);
    expect(u.searchParams.getAll("includeTag")).toEqual(["Trap", "Dark"]);
    expect([u.searchParams.get("state"), u.searchParams.get("sort"), u.searchParams.get("q"), u.searchParams.get("excludeTag"), u.searchParams.get("includeMode"), u.searchParams.get("limit"), u.searchParams.get("includeTotal"), u.searchParams.get("edge")]).toEqual(["TRASH", "name", "tr ap", "demo", "all", "240", "true", "last"]);
    await expect(api.listBeats({ cursor: "stale" })).rejects.toMatchObject({ status: 409, code: "CURSOR_STALE", detail: { current_revision: "9" } });
    await expect(api.listBeats({ cursor: "stale" })).rejects.toBeInstanceOf(CatalogApiError);
    for (const bad of [-1, 2 ** 53, 1.5]) {
      let thrown: unknown = null;
      try { api.legacyNavigation(bad, "rating"); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(CatalogApiError);
      expect((thrown as CatalogApiError).code).toBe("LEGACY_OFFSET_INVALID");
    }
    expect(f.calls.some((c) => c.url.includes("navigation/legacy"))).toBe(false);
    await api.legacyNavigation(240, "rating");
    expect(new URL(f.calls[f.calls.length - 1].url).search).toBe("?offset=240&sort=rating&limit=240");
  });
});
