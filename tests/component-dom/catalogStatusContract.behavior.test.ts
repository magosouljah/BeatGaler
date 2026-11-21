import { describe, expect, it } from "vitest";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogInteractionStore, type InteractionQuery } from "../../src/features/library/catalog/catalogInteractionStore";
import { resolveReadyQuerySet } from "../../src/features/library/catalog/catalogPlaybackSets";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

const POLL_MS = 5;

function harness({ releaseSetWhilePolling = false } = {}) {
  const beats = fakeBeats(2).map((beat) => ({ ...beat, tags: ["original"] }));
  const server = createCatalogFakeCommands({ beats, setReadyAfterPolls: 1, bulkBatch: 1 });
  const api = createCatalogFakeApi({ n: beats.length });
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const operationId = /^\/catalog\/v1\/operations\/([^/]+)$/.exec(path)?.[1];
    if (init?.method === "GET" && operationId) {
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
  return { commands, store, query, server, accountId, now, sleep };
}

const releasedError = { status: 409, code: "CURSOR_STALE", detail: { status: "RELEASED" } };
const blockedReport = { status: "BLOCKED", report: { total: 2, confirmed: 1, completed: false } };
const timeoutNotice = "La operación sigue en curso en el servidor; vuelve a consultar más tarde.";

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

  // CARACTERIZACIÓN ACTUAL (STOP-DESIGN C05, 2026-11-21): estos dos casos fijan la conducta de HOY ante BLOCKED
  // (sondeo hasta el límite sin aviso en el estado: bulk.error null), no la deseada. Hoy el servidor no escribe
  // BLOCKED en catalog_operations (failJob solo marca catalog_jobs), así que en producción se ve RUNNING/QUEUED.
  // Cuando el propietario decida qué debe hacer la Galería con BLOCKED, invertir estas aserciones.
  it("caracterización actual (STOP-DESIGN C05): bulk vuelve a consultar un BLOCKED hasta el límite, conserva el progreso y limpia la selección", async () => {
    const { store, query, server } = harness();
    await store.selectAll(query);

    const result = await store.startBulk("BULK_TRASH");

    expect(server.counters["GET /catalog/v1/operations/:id"]).toBe(3);
    expect(result).toMatchObject({ ...blockedReport, error: timeoutNotice });
    expect(store.getSnapshot()).toMatchObject({
      bulk: { ...blockedReport, error: null },
      selection: { status: "none" },
    });
  });

  it("caracterización actual (STOP-DESIGN C05): renombrar un tag queda en parcial cuando BLOCKED persiste hasta el límite", async () => {
    const { store, server } = harness();
    store.openRename("original");
    store.setRenameTarget("nuevo");
    await store.previewRename();

    const result = await store.confirmRename();

    expect(server.counters["GET /catalog/v1/operations/:id"]).toBe(3);
    expect(result).toMatchObject({ ...blockedReport, error: timeoutNotice });
    expect(store.getSnapshot().rename).toMatchObject({
      stage: "partial", error: "Renombrado blocked: 1/2 confirmados.",
    });
  });
});
