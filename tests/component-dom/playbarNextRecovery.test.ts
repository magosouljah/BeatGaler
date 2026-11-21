// @vitest-environment node
// «Siguiente»/«Anterior» de la Playbar: causa real = conjunto de resultados BUILDING tomado como vacío y conjunto obsoleto (CURSOR_STALE) sin recuperación;
// además los errores se propagaban a `.catch(() => {})`. Aquí: espera a READY, recuperación única ante CURSOR_STALE, errores visibles.
import { describe, expect, it, vi } from "vitest";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { createCatalogPlaybackSession, type PlaybackApi, type PlaybackQuery } from "../../src/features/library/catalog/catalogPlaybackSession";
import { PLAYBACK_SET_POLL_MS, resolveReadyQuerySet } from "../../src/features/library/catalog/catalogPlaybackSets";

const query: PlaybackQuery = { filters: { q: "", includeTags: [], excludeTags: [], includeMode: "ANY", state: "ACTIVE" } as never, sort: "manual" as never, revision: "7" };
const stale = () => new CatalogApiError(409, "CURSOR_STALE", "query set belongs to another revision/epoch", {});

function make(neighborImpl: PlaybackApi["neighbor"]) {
  const resolveSet = vi.fn(async () => ({ setId: `set-${resolveSet.mock.calls.length}`, memberCount: 5 }));
  const invalidateSet = vi.fn();
  const neighbor = vi.fn(neighborImpl);
  const api = { neighbor, startRound: vi.fn(), nextInRound: vi.fn(), consumeInRound: vi.fn(), releaseRound: vi.fn(async () => ({})) } as unknown as PlaybackApi;
  const session = createCatalogPlaybackSession({
    api, resolveSet, invalidateSet, accountId: () => "acc", consumerId: "p",
    resolveFile: async (beatId) => ({ fileId: `f-${beatId}`, version: "1" }),
    acquireSource: async (fileId) => ({ url: `blob:${fileId}`, cacheKey: fileId, release() {} } as never),
  });
  return { session, resolveSet, invalidateSet, neighbor };
}

describe("Playbar Next/Previous: conjunto obsoleto", () => {
  it("CURSOR_STALE una vez: descarta el conjunto, crea otro sobre la revisión vigente y avanza", async () => {
    let calls = 0;
    const { session, resolveSet, invalidateSet } = make(async ({ setId }) => { calls++; if (calls === 1) throw stale(); return { beatId: "b2", version: "1", member: true, total: 5 }; });
    await session.setQuery(query); await session.play({ beatId: "b1", version: "1", fileId: null });
    const t = await session.next();
    expect(t?.beatId).toBe("b2"); expect(invalidateSet).toHaveBeenCalledTimes(1); expect(resolveSet).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().current?.beatId).toBe("b2"); expect(session.getSnapshot().source?.url).toBe("blob:f-b2"); expect(session.getSnapshot().status).toBe("playing");
  });
  it("Anterior también se recupera", async () => {
    let calls = 0;
    const { session } = make(async () => { calls++; if (calls === 1) throw stale(); return { beatId: "b0", version: "1", member: true, total: 5 }; });
    await session.setQuery(query); await session.play({ beatId: "b1", version: "1", fileId: null });
    expect((await session.previous())?.beatId).toBe("b0");
  });
  it("dos CURSOR_STALE seguidos o cualquier otro error se PROPAGAN (la UI los muestra): no se tragan ni se reintenta sin fin", async () => {
    const twice = make(async () => { throw stale(); });
    await twice.session.setQuery(query); await twice.session.play({ beatId: "b1", version: "1", fileId: null });
    await expect(twice.session.next()).rejects.toMatchObject({ code: "CURSOR_STALE" }); expect(twice.neighbor).toHaveBeenCalledTimes(2);
    const other = make(async () => { throw new CatalogApiError(500, "BOOM", "boom", {}); });
    await other.session.setQuery(query); await other.session.play({ beatId: "b1", version: "1", fileId: null });
    await expect(other.session.next()).rejects.toMatchObject({ code: "BOOM" }); expect(other.invalidateSet).not.toHaveBeenCalled();
  });
  it("fin de lista (sin siguiente) no es un error: no cambia de pista", async () => {
    const { session } = make(async () => ({ beatId: null, version: null, member: true, total: 5, edge: "END" }));
    await session.setQuery(query); await session.play({ beatId: "b1", version: "1", fileId: null });
    expect(await session.next()).toBeNull(); expect(session.getSnapshot().current?.beatId).toBe("b1");
  });
});

describe("resolveReadyQuerySet: espera a READY", () => {
  const set = (status: string, memberCount: number) => ({ setId: "qs-1", status, scope: "ACTIVE", baseRevision: "7", memberCount, checkpointSeq: 0, predicateHash: "h", errorCode: null });
  it("BUILDING (memberCount 0) → BUILDING → READY: devuelve el conteo real, no 0", async () => {
    const getQuerySet = vi.fn().mockResolvedValueOnce(set("BUILDING", 0)).mockResolvedValueOnce(set("READY", 36));
    const sleeps: number[] = [];
    const r = await resolveReadyQuerySet({ commands: { createQuerySet: vi.fn(async () => set("BUILDING", 0)) as never, getQuerySet: getQuerySet as never }, accountId: "a", query, sleep: async (ms) => { sleeps.push(ms); } });
    expect(r).toEqual({ setId: "qs-1", memberCount: 36 }); expect(getQuerySet).toHaveBeenCalledTimes(2); expect(sleeps).toEqual([PLAYBACK_SET_POLL_MS, PLAYBACK_SET_POLL_MS]);
  });
  it("ya READY: sin sondeo; FAILED/STALE → CURSOR_STALE; BUILDING eterno → QUERY_SET_BUILDING_BUSY", async () => {
    const getQuerySet = vi.fn();
    expect(await resolveReadyQuerySet({ commands: { createQuerySet: (async () => set("READY", 3)) as never, getQuerySet }, accountId: "a", query })).toEqual({ setId: "qs-1", memberCount: 3 }); expect(getQuerySet).not.toHaveBeenCalled();
    await expect(resolveReadyQuerySet({ commands: { createQuerySet: (async () => set("FAILED", 0)) as never, getQuerySet }, accountId: "a", query })).rejects.toMatchObject({ code: "CURSOR_STALE" });
    let t = 0;
    await expect(resolveReadyQuerySet({ commands: { createQuerySet: (async () => set("BUILDING", 0)) as never, getQuerySet: (async () => set("BUILDING", 0)) as never }, accountId: "a", query, timeoutMs: 500, sleep: async () => { t += 200; }, now: () => t })).rejects.toMatchObject({ code: "QUERY_SET_BUILDING_BUSY" });
  });
});
