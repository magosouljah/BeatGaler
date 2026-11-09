// @vitest-environment node
// T14 / V06 — Sesión musical: I2 (cola prioritaria en Next/ended; Previous con progress > 0,05 hace seek(0) sin consumir; filtros/sort no
// tocan el audio actual; currentBeat fuera del query → primero/último; query vacío no interrumpe), Shuffle sin RNG en cliente con ronda del
// servidor (sin repetición, retry del mismo comando tras fallo de transporte, play directo consume, ronda completa/repeat, filtros → ronda
// nueva, revisión → reconstrucción preservando consumidos), fuente arrendada con refcount `player` (la evicción del grid no la libera),
// evento autoritativo, teardown por cuenta.
import { describe, expect, it } from "vitest";
import { createCatalogApi, type CatalogQueryFilters } from "../../src/features/library/catalog/catalogApi";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import { createCatalogPlaybackSession, type PlaybackApi, type PlaybackQuery } from "../../src/features/library/catalog/catalogPlaybackSession";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

function harness(opts: Parameters<typeof createCatalogFakeCommands>[0] = {}) {
  const server = createCatalogFakeCommands({ beats: fakeBeats(12), rng: (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })(), ...opts });
  let fetchFail = false; let fetchCalls = 0;
  const fetchImpl: typeof fetch = async (i, init) => { fetchCalls++; if (fetchFail && String(i).includes("/next")) { fetchFail = false; throw new TypeError("network down"); } return server.fetchImpl(i, init); };
  const common = { fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }) };
  const cmd = createCatalogApi(common); void cmd;
  const api: PlaybackApi = {
    async startRound(input) { const r = await fetchImpl("https://cloud.invalid/api/catalog/v1/playback/rounds", { method: "POST", headers: { "X-Catalog-Era": "e", "X-Catalog-Epoch": "1", "Content-Type": "application/json" }, body: JSON.stringify(input) }); const b = await r.json(); if (!r.ok) throw Object.assign(new Error(b.error), { code: b.code, status: r.status, detail: b.detail ?? {} }); return b; },
    async nextInRound(input) { const r = await fetchImpl(`https://cloud.invalid/api/catalog/v1/playback/rounds/${input.roundId}/next`, { method: "POST", headers: { "X-Catalog-Era": "e", "X-Catalog-Epoch": "1", "Content-Type": "application/json" }, body: JSON.stringify(input) }); const b = await r.json(); if (!r.ok) { const { CatalogApiError } = await import("../../src/features/library/catalog/catalogApi"); throw new CatalogApiError(r.status, b.code, b.error, b.detail ?? {}); } return b; },
    async consumeInRound(input) { const r = await fetchImpl(`https://cloud.invalid/api/catalog/v1/playback/rounds/${input.roundId}/consume`, { method: "POST", headers: { "X-Catalog-Era": "e", "X-Catalog-Epoch": "1", "Content-Type": "application/json" }, body: JSON.stringify(input) }); const b = await r.json(); if (!r.ok) { const { CatalogApiError } = await import("../../src/features/library/catalog/catalogApi"); throw new CatalogApiError(r.status, b.code, b.error, b.detail ?? {}); } return b; },
    async releaseRound(roundId) { await fetchImpl(`https://cloud.invalid/api/catalog/v1/playback/rounds/${roundId}/release`, { method: "POST", headers: { "X-Catalog-Era": "e", "X-Catalog-Epoch": "1", "Content-Type": "application/json" }, body: "{}" }); },
    async neighbor(input) { const p = new URLSearchParams({ direction: input.direction, sort: input.sort }); if (input.beatId) p.set("beatId", input.beatId); const r = await fetchImpl(`https://cloud.invalid/api/catalog/v1/query-sets/${input.setId}/neighbor?${p}`, { method: "GET", headers: {} }); return r.json(); },
  };
  const media = createCatalogMediaClient({ ...common, accountId: () => "acc-1", createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL: () => {} });
  const sets = new Map<string, Promise<{ setId: string; memberCount: number }>>();
  const resolveSet = (q: PlaybackQuery) => { const k = JSON.stringify([q.filters, q.revision]); if (!sets.has(k)) sets.set(k, (async () => { const r = await fetchImpl("https://cloud.invalid/api/catalog/v1/query-sets", { method: "POST", headers: { "X-Catalog-Era": "e", "X-Catalog-Epoch": "1", "Content-Type": "application/json" }, body: JSON.stringify({ query: { ...q.filters, sort: q.sort }, consumer: { id: "p", kind: "SHUFFLE" } }) }); const b = await r.json(); return { setId: b.setId, memberCount: b.memberCount }; })()); return sets.get(k)!; };
  let account = "acc-1"; const released: string[] = [];
  const session = createCatalogPlaybackSession({ api, resolveSet, resolveFile: async (beatId) => (server.beats.has(beatId) ? { fileId: `f-${beatId}`, version: String(server.beats.get(beatId)!.version) } : null), acquireSource: async (fileId) => { const l = await media.acquire(fileId, "player"); return { ...l, release() { released.push(fileId); l.release(); } }; }, accountId: () => account, consumerId: "p", idempotencyKey: () => `k-${Math.random().toString(36).slice(2)}` });
  const query = (over: Partial<CatalogQueryFilters> = {}, sort: PlaybackQuery["sort"] = "manual"): PlaybackQuery => ({ filters: { state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "any", ...over }, sort, revision: server.revision() });
  return { server, session, media, query, released, setFetchFail: (v: boolean) => { fetchFail = v; }, fetchCalls: () => fetchCalls, setAccount: (a: string) => { account = a; } };
}

describe("catalogPlaybackSession (V06)", () => {
  it("I2 secuencial: Next/Previous por el orden del conjunto; fuera del query → primero/último; bordes; cola prioritaria; Previous con progress > 0,05 hace seek(0) sin consumir cola", async () => {
    const h = harness();
    await h.session.setQuery(h.query());
    await h.session.play({ beatId: "g3", version: "1", fileId: null });
    expect(h.session.getSnapshot().current?.beatId).toBe("g3"); expect(h.session.getSnapshot().source?.url).toMatch(/^blob:/);
    expect((await h.session.next())?.beatId).toBe("g4"); expect((await h.session.previous())?.beatId).toBe("g3");
    h.session.setProgress(0.5); expect((await h.session.previous())?.beatId).toBe("g3"); expect(h.session.getSnapshot().progress).toBe(0); // seek(0)
    h.session.enqueue({ beatId: "g9", version: "1", fileId: null }); h.session.enqueue({ beatId: "g1", version: "1", fileId: null });
    expect((await h.session.next())?.beatId).toBe("g9"); expect(h.session.getSnapshot().queue.map((t) => t.beatId)).toEqual(["g1"]);
    h.session.setProgress(0.9); expect((await h.session.previous())?.beatId).toBe("g9"); expect(h.session.getSnapshot().queue.length).toBe(1, "Previous no consume la cola");
    expect((await h.session.ended())?.beatId).toBe("g1");
    // fuera del query vigente: filtro que excluye g1 → Next empieza por el primero del nuevo query; el audio actual no cambió al filtrar
    await h.session.setQuery(h.query({ includeTags: ["even"] }));
    expect(h.session.getSnapshot().current?.beatId).toBe("g1");
    expect((await h.session.next())?.beatId).toBe("g0");
    await h.session.play({ beatId: "g10", version: "1", fileId: null });
    expect(await h.session.next({ reason: "ended" })).toBeNull(); expect(h.session.getSnapshot().status).toBe("ended"); // borde final, repeat off
    h.session.setRepeat("all"); expect((await h.session.next({ reason: "ended" }))?.beatId).toBe("g0");
    // query vacío no interrumpe la canción actual ni inventa resultados
    await h.session.setQuery(h.query({ q: "zzz-no-match" }));
    expect(await h.session.next()).toBeNull(); expect(h.session.getSnapshot().current?.beatId).toBe("g0");
  });

  it("Shuffle: ronda del servidor sin repetición hasta completar; sort no cambia la ronda; filtros → ronda nueva; ronda completa: repeat-off detiene por ended, repeat-all abre otra; retry tras fallo de transporte repite el mismo comando", async () => {
    const h = harness();
    await h.session.setQuery(h.query({ includeTags: ["even"] })); // 6 beats
    await h.session.setShuffle(true);
    await h.session.play({ beatId: "g0", version: "1", fileId: null });
    const seen: string[] = ["g0"];
    for (let i = 0; i < 5; i++) { const t = await h.session.next(); expect(t).not.toBeNull(); seen.push(t!.beatId); }
    expect(new Set(seen).size).toBe(6, "ningún beat repetido dentro de la ronda (la actual se consumió al abrirla)");
    expect(h.session.getSnapshot().round?.remaining).toBe(0);
    h.session.setRepeat("off");
    expect(await h.session.next({ reason: "ended" })).toBeNull(); expect(h.session.getSnapshot().status).toBe("ended");
    const manual = await h.session.next(); expect(manual).not.toBeNull(); // Next manual abre otra ronda
    const round2 = h.session.getSnapshot().round!; expect(round2.remaining).toBe(4); // 6 − actual excluida − sorteado
    // sort no cambia la ronda
    await h.session.setQuery(h.query({ includeTags: ["even"] }, "name"));
    expect(h.session.getSnapshot().round?.roundId).toBe(round2.roundId);
    // fallo de transporte en next: el comando pendiente se conserva y el retry devuelve el MISMO beat sin consumir otro
    h.setFetchFail(true);
    await expect(h.session.next()).rejects.toThrow(/network down/);
    const pending = h.session.getSnapshot().lastCommand; expect(pending?.retryable).toBe(true);
    const r = await h.session.next(); expect(r).not.toBeNull();
    const srvRound = h.server.round(round2.roundId)!; expect(srvRound.remaining).toBe(3); expect(srvRound.commands.has(pending!.key)).toBe(true);
    // filtros nuevos → ronda nueva (la anterior se libera)
    await h.session.setQuery(h.query({ includeTags: ["odd"] }));
    expect(h.session.getSnapshot().round).toBeNull(); expect(h.server.round(round2.roundId)?.status).toBe("RELEASED");
    const t = await h.session.next(); expect(t).not.toBeNull(); expect(h.server.beats.get(t!.beatId)!.tags).toContain("odd");
    // repeat-all: al completar la ronda abre otra automáticamente por ended
    h.session.setRepeat("all");
    for (let i = 0; i < 20; i++) await h.session.next({ reason: "ended" });
    expect(h.session.getSnapshot().status).toBe("playing");
  });

  it("revisión nueva → ronda stale → reconstruida preservando consumidos (ningún repetido entre ambas); play directo consume el miembro; evento autoritativo saca de la cola; teardown libera fuente y ronda", async () => {
    const h = harness();
    await h.session.setQuery(h.query({ includeTags: ["odd"] })); // 6
    await h.session.setShuffle(true);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) seen.add((await h.session.next())!.beatId);
    const round1 = h.session.getSnapshot().round!.roundId;
    h.server.externalEdit("g11"); // revisión nueva
    await h.session.setQuery(h.query({ includeTags: ["odd"] }));
    expect(h.session.getSnapshot().round?.stale).toBe(true);
    for (let i = 0; i < 3; i++) { const t = await h.session.next(); if (t) { expect(seen.has(t.beatId)).toBe(false); seen.add(t.beatId); } }
    expect(h.session.getSnapshot().round?.roundId).not.toBe(round1);
    expect(seen.size).toBe(6);
    // play directo de un miembro en una ronda nueva: se consume (no vuelve a salir)
    const h2 = harness(); await h2.session.setQuery(h2.query({ includeTags: ["even"] })); await h2.session.setShuffle(true);
    await h2.session.play({ beatId: "g4", version: "1", fileId: null });
    const drawn: string[] = []; for (let i = 0; i < 5; i++) drawn.push((await h2.session.next())!.beatId);
    expect(drawn).not.toContain("g4"); expect(new Set(drawn).size).toBe(5);
    h2.session.enqueue({ beatId: "g6", version: "1", fileId: null });
    h2.session.onAuthoritativeEvent({ kind: "TRASHED", beatId: "g6" });
    expect(h2.session.getSnapshot().queue).toEqual([]);
    const roundId = h2.session.getSnapshot().round!.roundId;
    h2.setAccount("acc-2"); await h2.session.teardown();
    expect(h2.session.getSnapshot()).toMatchObject({ current: null, round: null, queue: [], accountId: "acc-2" });
    expect(h2.released.length).toBeGreaterThan(0); expect(h2.server.round(roundId)?.status).toBe("RELEASED");
  });
});
