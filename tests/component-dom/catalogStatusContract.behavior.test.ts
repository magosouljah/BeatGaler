import { describe, expect, it, vi } from "vitest";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogInteractionStore, createGallerySelection, type InteractionQuery } from "../../src/features/library/catalog/catalogInteractionStore";
import { resolveReadyQuerySet } from "../../src/features/library/catalog/catalogPlaybackSets";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

const POLL_MS = 5;

function harness({ releaseSetWhilePolling = false, blockWhilePolling = false } = {}) {
  const beats = fakeBeats(2).map((beat) => ({ ...beat, tags: ["original"] }));
  const server = createCatalogFakeCommands({ beats, setReadyAfterPolls: 1, bulkBatch: 1 });
  const api = createCatalogFakeApi({ n: beats.length });
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const operationId = /^\/catalog\/v1\/operations\/([^/]+)$/.exec(path)?.[1];
    if (blockWhilePolling && init?.method === "GET" && operationId) {
      const operation = server.operation(operationId);
      // Simula una fila BLOCKED tras confirmar el primer lote, antes de ejecutar el segundo.
      if (operation?.status === "RUNNING") operation.status = "BLOCKED";
    }
    const response = await server.fetchImpl(input, init);
    if (releaseSetWhilePolling && init?.method === "GET" && /^\/catalog\/v1\/query-sets\/[^/]+$/.test(path) && response.ok) {
      // Entre la publicación de READY y el GET, otro consumidor liberó el conjunto.
      return Response.json({ ...await response.json(), status: "RELEASED" });
    }
    return response;
  };
  const commands = createCatalogCommandsApi({
    fetchImpl,
    baseUrl: () => "https://cloud.invalid",
    headers: () => ({ era: "era-fake", epoch: "1" }),
  });
  const accountId = () => "fake-user";
  let elapsed = 0;
  const now = () => elapsed;
  const sleep = async (ms: number) => { elapsed += ms; };
  const store = createCatalogInteractionStore({
    commands, api, accountId, now, sleep,
    pollIntervalMs: POLL_MS,
    setReadyTimeoutMs: POLL_MS * 3,
    maxPollMs: POLL_MS,
  });
  const query: InteractionQuery = {
    filters: { state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "any" },
    sort: "rating",
    revision: server.revision(),
  };
  const setNotice = vi.fn();
  const setSelectMode = vi.fn();
  const gallery = createGallerySelection({
    store, query, setNotice, setSelectMode, ordinalOf: () => undefined, refreshAfterMutation: vi.fn(),
  });
  return { commands, store, query, server, accountId, now, sleep, gallery, setNotice, setSelectMode };
}

const releasedError = { status: 409, code: "CURSOR_STALE", detail: { status: "RELEASED" } };
const blockedNotice = "La operación quedó bloqueada y no se completó. Revisa tu conexión o inténtalo de nuevo.";
const blockedResult = { status: "BLOCKED", report: { total: 2, confirmed: 1, completed: false }, error: blockedNotice };

describe("contrato de estados del catálogo", () => {
  it("seleccionar todo rechaza un conjunto RELEASED tras el primer GET y no crea una selección", async () => {
    const { store, query, server } = harness({ releaseSetWhilePolling: true });

    await expect(store.selectAll(query)).rejects.toMatchObject(releasedError);

    expect(server.counters["GET /catalog/v1/query-sets/:id"]).toBe(1);
    expect(server.counters["POST /catalog/v1/selections"]).toBeUndefined();
    expect(store.getSnapshot().selection).toMatchObject({
      status: "none", count: 0, selectionId: null, error: expect.stringContaining("RELEASED"),
    });
  });

  it("el resolutor del reproductor rechaza un conjunto RELEASED tras el primer GET", async () => {
    const { commands, accountId, query, sleep, now, server } = harness({ releaseSetWhilePolling: true });

    await expect(resolveReadyQuerySet({
      commands, accountId: accountId(), query, sleep, now, pollMs: POLL_MS, timeoutMs: POLL_MS * 3,
    })).rejects.toMatchObject(releasedError);

    expect(server.counters["GET /catalog/v1/query-sets/:id"]).toBe(1);
  });

  it.each(["BULK_PATCH", "BULK_TRASH"] as const)("%s detiene el sondeo en BLOCKED, publica el aviso y limpia la selección", async (kind) => {
    const { store, query, server, gallery, setNotice, setSelectMode } = harness({ blockWhilePolling: true });
    await store.selectAll(query);
    const selectionId = store.getSnapshot().selection.selectionId!;

    if (kind === "BULK_PATCH") gallery.applyBulkUpdate({ rating: 5 });
    else gallery.handleRemoveBulk();

    await vi.waitFor(() => expect(setNotice).toHaveBeenCalledExactlyOnceWith(blockedNotice));
    expect(server.counters["GET /catalog/v1/operations/:id"]).toBe(2);
    expect(server.counters["POST /catalog/v1/operations"]).toBe(1);
    expect(server.selection(selectionId)?.status).toBe("FROZEN");
    expect(setSelectMode).toHaveBeenCalledExactlyOnceWith(false);
    expect(store.getSnapshot()).toMatchObject({
      bulk: blockedResult,
      selection: { status: "none", count: 0, selectionId: null },
    });
  });

  it("RUNNING mantiene la selección congelada y vuelve a sondear hasta COMPLETED", async () => {
    const { store, query, server } = harness();
    await store.selectAll(query);
    const observed = vi.fn(store.getSnapshot);
    store.subscribe(observed);

    const result = await store.startBulk("BULK_TRASH");

    expect(observed.mock.results.map(({ value }) => value)).toContainEqual(expect.objectContaining({
      bulk: expect.objectContaining({ status: "RUNNING", error: null }),
      selection: expect.objectContaining({ status: "frozen" }),
    }));
    expect(server.counters["GET /catalog/v1/operations/:id"]).toBe(2);
    expect(result).toMatchObject({ status: "COMPLETED", report: { confirmed: 2, completed: true }, error: null });
  });

  it("renombrar un tag detiene el sondeo en BLOCKED y publica el aviso con el progreso parcial conservado", async () => {
    const { store, server, gallery, setNotice } = harness({ blockWhilePolling: true });
    store.openRename("original");
    store.setRenameTarget("nuevo");
    await store.previewRename();

    gallery.confirmTagRename();

    await vi.waitFor(() => expect(setNotice).toHaveBeenCalledExactlyOnceWith(blockedNotice));
    expect(server.counters["GET /catalog/v1/operations/:id"]).toBe(2);
    expect(store.getSnapshot().rename).toMatchObject({
      stage: "partial", error: blockedNotice, operation: blockedResult,
    });
  });
});
