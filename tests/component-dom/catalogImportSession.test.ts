import { afterEach, expect, it, vi } from "vitest";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createImportSession } from "../../src/features/library/catalog/catalogImportSession";
import { createCatalogMutations, type OperationRef } from "../../src/features/library/catalog/catalogMutations";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";
import { createCatalogFakeCommands } from "../helpers/catalogFakeCommands";
import { createFakeImportPort, reviewBeat } from "../helpers/catalogImportHarness";

afterEach(() => { vi.useRealTimers(); });

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function setup(result: "committed" | "uncertain" | "blocked" | "timeout" | "rejected" | "failed" = "committed", failureCode = "BOOM") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const server = createCatalogFakeCommands({ transferVerifyAfterPolls: result === "timeout" || result === "blocked" ? 99 : undefined });
  if (result === "uncertain") server.directState.faults.push("uncertain");
  if (result === "rejected") server.setFailure({ route: /\/operations$/, status: 503, code: "OFFLINE" });
  if (result === "blocked") server.setFailure({ route: /\/commit$/, status: 409, code: "VERSION_CONFLICT" });
  if (result === "failed") server.setFailure({ route: /\/commit$/, status: 500, code: failureCode });
  const sendGate = gate();
  const sendEntered = gate();
  const requests: string[] = [];
  const common = {
    fetchImpl: (async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return server.fetchImpl(input, init);
    }) as typeof fetch,
    baseUrl: () => "https://cloud.invalid/api", token: () => "fake", csrf: () => "fake",
    headers: () => ({ era: "era-fake", epoch: "1" }),
  };
  let refs: OperationRef[] = [];
  const persistedAtSend: OperationRef[][] = [];
  const mutations = createCatalogMutations({
    commands: createCatalogCommandsApi(common),
    transfer: createCatalogTransfer({
      ...common, sleep: async () => {}, pollIntervalMs: 1, maxPollMs: result === "timeout" ? 0 : undefined,
      direct: {
        ...server.directPort,
        async send(input, options) {
          persistedAtSend.push([...refs]);
          sendEntered.release();
          await sendGate.wait;
          return server.directPort.send(input, options);
        },
      },
    }),
    accountId: () => "fake",
    refStore: { load: () => refs, save: (_account, next) => { refs = next; } },
    prepareFiles: async (files) => files,
  });
  const importer = createFakeImportPort();
  const setBusy = vi.fn();
  const refreshLibrary = vi.fn();
  const importBeat = vi.fn(mutations.importBeat);
  const session = createImportSession({
    mutations: { ...mutations, importBeat }, importer: importer.port, landsProbe: () => true,
    clock: { setTimeout }, setBusy, refreshLibrary, alert: async () => {},
  });
  const trace: unknown[] = [];
  session.subscribe(() => {
    const { review, uploads, pendingCards, notice, batchOpen } = session.getSnapshot();
    trace.push([review?.beat.name ?? null, uploads.map((upload) => upload.percent), pendingCards.map((card) => card.realId ?? card.id), notice, batchOpen]);
  });
  const beat = reviewBeat("Beat", { image_base64: "data:image/png;base64,AA==" });
  importer.retain(beat.id, new File([new Uint8Array(16)], "beat.mp3", { type: "audio/mpeg" }));
  session.open([beat]);
  return {
    beat, importer, importBeat, session, trace, setBusy, refreshLibrary, server, persistedAtSend, requests, sendEntered,
    async settle() {
      sendGate.release();
      const outcome = await importBeat.mock.results[0].value;
      // Deja correr la continuación que publica el resultado de la subida.
      await Promise.resolve();
      await Promise.resolve();
      return outcome;
    },
  };
}

it("publica revisión, tarjeta provisional y real, y confirma el traspaso una sola vez", async () => {
  const h = setup();
  const progress = vi.fn();
  const saving = h.session.save(h.beat, progress);
  await h.sendEntered.wait;
  await saving;
  expect(progress.mock.calls.slice(0, 2).map(([p]) => [p.stage, p.uploadedBytes])).toEqual([["preparing", 0], ["master", 0]]);
  const outcome = await h.settle();
  expect(outcome.status).toBe("committed");
  const realId = outcome.beatId;
  expect(h.persistedAtSend).toEqual([
    [expect.objectContaining({ operationId: outcome.operationId, beatId: realId, kind: "IMPORT", nameKey: "beat" })],
    [expect.objectContaining({ operationId: outcome.operationId, beatId: realId, kind: "IMPORT", nameKey: "beat" })],
  ]);
  expect(h.requests).toContain(`POST /api/catalog/v1/operations/${outcome.operationId}/commit`);
  expect(h.server.beats.get(realId)?.name).toBe("Beat");
  expect(h.session.getSeededArtwork(realId)).toBe(h.beat.image_base64);
  h.session.noteResident(new Set([realId]));
  h.session.noteResident(new Set([realId]));
  expect(h.trace).toEqual([
    ["Beat", [], [], null, true],
    [null, [0], [h.beat.id], null, true],
    ...[23, 47, 70, 94, 100].map((percent) => [null, [percent], [h.beat.id], null, true]),
    [null, [], [realId], "«Beat» importado.", false],
    [null, [], [], "«Beat» importado.", false],
  ]);
  expect(h.setBusy.mock.calls).toEqual([[h.beat.id, true], [realId, true], [realId, false, true], [h.beat.id, false]]);
  vi.advanceTimersByTime(3999);
  expect(h.session.getSeededArtwork(realId)).toBe(h.beat.image_base64);
  vi.advanceTimersByTime(1001);
  expect(h.session.getSeededArtwork(realId)).toBeUndefined();
  expect(h.setBusy.mock.calls.filter(([, , completed]) => completed)).toEqual([[realId, false, true]]);
  expect(h.refreshLibrary).toHaveBeenCalledTimes(1);
  expect(h.importer.released).toEqual([h.beat.id]);
});

it.each(["uncertain", "blocked", "timeout"] as const)("publica el resultado %s, libera el archivo y no reenvía", async (status) => {
  const h = setup(status);
  await h.session.save(h.beat);
  expect(h.session.getSnapshot().pendingCards.map((card) => card.id)).toEqual([h.beat.id]);
  const outcome = await h.settle();
  expect(outcome.status).toBe(status);
  const notice = status === "uncertain" ? /no se pudo confirmar.*No se reenvía/ : /sigue confirmándose.*No se reenvía/;
  expect(h.trace[0]).toEqual(["Beat", [], [], null, true]);
  expect(h.trace[1]).toEqual([null, [0], [h.beat.id], null, true]);
  expect(h.trace.at(-1)).toEqual([null, [], [], expect.stringMatching(notice), false]);
  expect(h.importer.released).toEqual([h.beat.id]);
  expect(h.refreshLibrary).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(6000);
  expect(h.importBeat).toHaveBeenCalledTimes(1);
  expect(h.requests.filter((request) => request === "POST /api/catalog/v1/operations")).toHaveLength(1);
});

it("mantiene la revisión abierta si el rechazo llega tras preparar y antes del primer progreso de subida", async () => {
  const h = setup("rejected");
  const progress = vi.fn();
  await expect(h.session.save(h.beat, progress)).rejects.toThrow("fake OFFLINE");
  expect(progress.mock.calls.map(([p]) => p.stage)).toEqual(["preparing"]);
  expect(h.trace).toEqual([["Beat", [], [], null, true]]);
  expect(h.importer.released).toEqual([]);
  expect(h.persistedAtSend).toEqual([]);
  expect(h.refreshLibrary).not.toHaveBeenCalled();
});

it("reabre la revisión con lo editado al fallar en segundo plano", async () => {
  const h = setup("failed");
  const updated = { ...h.beat, name: "Editado", bpm: "125", tags: ["drums"] };
  await h.session.save(updated);
  expect(h.trace[1]).toEqual([null, [0], [h.beat.id], null, true]);
  await expect(h.settle()).rejects.toThrow("fake BOOM");
  expect(h.session.getSnapshot().review?.beat).toEqual(updated);
  expect(h.trace.at(-1)).toEqual(["Editado", [], [], "No se pudo importar «Editado»: fake BOOM. Tus cambios siguen en la revisión.", true]);
  expect(h.importer.released).toEqual([]);
  expect(h.refreshLibrary).not.toHaveBeenCalled();
});

it.each(["varios intentos", "varios intentos.", "varios intentos. \t"])("conserva el final del mensaje de fallo %j y deja un solo punto", async (reason) => {
  const h = setup("failed", reason);
  await h.session.save(h.beat);
  await expect(h.settle()).rejects.toThrow("fake varios intentos");
  expect(h.session.getSnapshot().notice).toBe("No se pudo importar «Beat»: fake varios intentos. Tus cambios siguen en la revisión.");
});

it("retira la provisional a los 5000 ms si la real todavía no reside", async () => {
  const h = setup();
  await h.session.save(h.beat);
  const { beatId } = await h.settle();
  vi.advanceTimersByTime(4999);
  expect(h.session.getSnapshot().pendingCards.map((card) => card.id)).toEqual([h.beat.id]);
  expect(h.setBusy.mock.calls.filter(([, , completed]) => completed)).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(h.session.getSnapshot().pendingCards).toEqual([]);
  h.session.noteResident(new Set([beatId]));
  expect(h.setBusy.mock.calls.filter(([, , completed]) => completed)).toEqual([[beatId, false, true]]);
});
