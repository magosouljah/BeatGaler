import { describe, expect, it } from "vitest";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { createBeatEditor, readOutcome } from "../../src/features/library/catalog/catalogBeatEditor";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { beatFromCatalogDetail, createCatalogMutations, type PatchOutcome, type TransferOutcome } from "../../src/features/library/catalog/catalogMutations";
import { createCatalogTransfer, type TransferOperationDto } from "../../src/features/library/catalog/catalogTransfer";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

const error = new CatalogApiError(503, "UNAVAILABLE", "catálogo no disponible");
const nameTaken = new CatalogApiError(409, "NAME_TAKEN", "nombre repetido");
const versionConflict = new CatalogApiError(409, "VERSION_CONFLICT", "versión anterior");
const operation = {
  operationId: "top-1", kind: "REPLACE", status: "COMMITTED", beatId: "g0", parts: [],
  progress: { total: 1, verified: 1, receipts: 1 }, reservation: null,
  result: { beatId: "g0", version: "2", revision: "11" }, lastError: null,
} satisfies TransferOperationDto;
const transfer = { operationId: "top-1", beatId: "g0", operation: null, retained: true };
const outcomes = {
  committed: [{ ...transfer, status: "committed", operation, version: "2", revision: "11" }, { reading: "success", status: "committed" }],
  ok: [{ status: "ok", beat: null, revision: "11", noop: false, operationId: "op-1", replay: false }, { reading: "success", status: "ok" }],
  uncertain: [{ ...transfer, status: "uncertain", parts: ["MASTER:0"] }, { reading: "pending", why: "uncertain", error: undefined }],
  blocked: [{ ...transfer, status: "blocked", error }, { reading: "pending", why: "blocked", error }],
  timeout: [{ ...transfer, status: "timeout", error: null }, { reading: "pending", why: "timeout", error: null }],
  conflict: [{ status: "conflict", currentVersion: "2", expectedVersion: "1", error: versionConflict }, { reading: "rejected", status: "conflict", why: "conflict", error: versionConflict }],
  error: [{ status: "error", error }, { reading: "rejected", status: "error", why: "error", error }],
  failed: [{ ...transfer, status: "failed", error }, { reading: "rejected", status: "failed", why: "failed", error }],
  canceled: [{ ...transfer, status: "canceled", retained: false, error: null }, { reading: "rejected", status: "canceled", why: "canceled", error: null }],
} satisfies Record<(TransferOutcome | PatchOutcome)["status"], [TransferOutcome | PatchOutcome, ReturnType<typeof readOutcome>]>;

describe("readOutcome", () => {
  it.each(Object.entries(outcomes))("clasifica %s", (_status, [outcome, reading]) => {
    expect(readOutcome(outcome)).toEqual(reading);
  });
  it.each([
    [{ ...transfer, status: "conflict", error: versionConflict }, "conflict", "conflict"],
    [{ status: "error", error: nameTaken }, "error", "name-taken"],
    [{ ...transfer, status: "failed", error: nameTaken }, "failed", "name-taken"],
    [{ ...transfer, status: "canceled", error: nameTaken }, "canceled", "name-taken"],
    [{ thrown: nameTaken }, "error", "name-taken"],
    [{ thrown: error }, "error", "error"],
    [{ thrown: "fallo de lectura" }, "error", "error"],
  ] as const)("conserva el estado y el error de %j", (outcome, status, why) => {
    expect(readOutcome(outcome)).toEqual({ reading: "rejected", status, why, error: "thrown" in outcome ? outcome.thrown : outcome.error });
  });
  it("mantiene bloqueado un resultado pendiente aunque incluya un error de nombre", () => {
    expect(readOutcome({ ...transfer, status: "blocked", error: nameTaken })).toEqual({ reading: "pending", why: "blocked", error: nameTaken });
  });
});

function setup({ blocked = false, timeout = false, readFailsAfterPatch = false } = {}) {
  let patched = false;
  const server = createCatalogFakeCommands({ beats: fakeBeats(1), transferVerifyAfterPolls: blocked || timeout ? 99 : undefined });
  if (blocked) server.setFailure({ route: /\/commit$/, status: 409, code: "VERSION_CONFLICT" });
  const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const common = {
    fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname.replace(/^.*?\/catalog\/v1/, "/catalog/v1");
      requests.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (readFailsAfterPatch && patched && (init?.method ?? "GET") === "GET" && path === "/catalog/v1/beats/g0") {
        return new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "sin lectura" } }), { status: 503, headers: { "content-type": "application/json" } });
      }
      if ((init?.method ?? "GET") === "PATCH") patched = true;
      return server.fetchImpl(input, init);
    }) as typeof fetch,
    baseUrl: () => "https://cloud.invalid/api", token: () => "fake", csrf: () => "fake",
    headers: () => ({ era: "era-fake", epoch: "1" }),
  };
  let refs: ReturnType<ReturnType<typeof createCatalogMutations>["pendingOperations"]> = [];
  const mutations = createCatalogMutations({
    commands: createCatalogCommandsApi(common),
    transfer: createCatalogTransfer({ ...common, direct: server.directPort, sleep: async () => {}, pollIntervalMs: 1, maxPollMs: timeout ? 0 : undefined }),
    accountId: () => "fake",
    refStore: { load: () => refs, save: (_account, next) => { refs = next; } },
    prepareFiles: async (files) => files,
  });
  let known: Awaited<ReturnType<typeof mutations.getBeat>> | undefined;
  const editor = createBeatEditor({
    mutations, knownDto: () => known, loadProject: async () => null,
    errorMessage: (e) => e instanceof Error ? e.message : String(e),
  });
  return {
    editor, server, requests,
    creates: () => requests.filter((r) => r.method === "POST" && r.path === "/catalog/v1/operations"),
    async show() {
      known = await mutations.getBeat("g0");
      return beatFromCatalogDetail(known, null);
    },
  };
}

const confirm = async () => true;
const audio = () => new File([new Uint8Array(16)], "new.mp3", { type: "audio/mpeg" });
const cover = () => new File([new Uint8Array(12)], "cover.png", { type: "image/png" });
const audioPending = "El reemplazo sigue confirmándose en el servidor; no lo repitas. El archivo se actualizará si se recibió.";

describe("BeatEditor con catálogo y puerto Direct falsos", () => {
  it("audio confirmado: un REPLACE versionado del MASTER, con texto y un envío Direct", async () => {
    const h = setup();
    expect(await h.editor.replaceAudio("g0", audio(), { confirm })).toEqual({
      reading: "success", status: "committed", artworkRemoved: false, kind: "MP3", replacedExisting: true, message: "MP3 reemplazado.",
    });
    expect(h.creates()).toEqual([expect.objectContaining({
      body: expect.objectContaining({
        kind: "REPLACE", beatId: "g0", expectedVersion: "1", metadata: null,
        parts: [expect.objectContaining({ role: "MASTER" })],
      }),
    })]);
    expect(h.requests[0]).toMatchObject({ method: "GET", path: "/catalog/v1/beats/g0" });
    expect(h.server.directSent).toHaveLength(1);
  });

  it("audio cancelado y formato no admitido: sin peticiones de escritura ni envíos", async () => {
    const h = setup();
    expect(await h.editor.replaceAudio("g0", audio(), { confirm: async () => false })).toEqual({ reading: "not-started", why: "cancelled" });
    expect(await h.editor.replaceAudio("g0", new File(["x"], "a.txt"), { confirm })).toEqual({ reading: "not-started", why: "unsupported" });
    expect(h.requests.map(({ method, path }) => [method, path])).toEqual([["GET", "/catalog/v1/beats/g0"]]);
    expect(h.server.directSent).toHaveLength(0);
  });

  it("audio incierto: un solo envío y ningún reenvío al solicitar el reemplazo de nuevo", async () => {
    const h = setup();
    h.server.directState.faults.push("uncertain");
    expect(await h.editor.replaceAudio("g0", audio(), { confirm })).toEqual({ reading: "pending", why: "uncertain", message: audioPending });
    expect(h.creates()).toHaveLength(1);
    expect(h.server.directSent).toHaveLength(1);
    expect(await h.editor.replaceAudio("g0", audio(), { confirm })).toEqual({
      reading: "rejected", why: "error",
      message: "Una subida anterior de este beat todavía se está confirmando en el servidor. No se vuelve a enviar para no duplicarla: espera a que termine (el beat aparecerá si se recibió).",
    });
    expect(h.creates()).toHaveLength(1);
    expect(h.server.directSent).toHaveLength(1);
  });

  it.each([["blocked", { blocked: true }], ["timeout", { timeout: true }]] as const)(
    "portada %s: devuelve pendiente y conserva un solo REPLACE versionado de ARTWORK",
    async (why, options) => {
      const h = setup(options);
      expect(await h.editor.replaceArtwork("g0", [{ kind: "file", file: cover() }])).toEqual({
        reading: "pending", why,
        message: "El cambio sigue confirmándose en el servidor; no lo repitas. La portada se actualizará si se recibió.",
      });
      expect(h.creates()).toEqual([expect.objectContaining({
        body: expect.objectContaining({ kind: "REPLACE", beatId: "g0", expectedVersion: "1", parts: [expect.objectContaining({ role: "ARTWORK" })] }),
      })]);
      expect(h.server.directSent).toHaveLength(1);
    },
  );

  it("Drawer sin archivos: PATCH versionado y conflicto con el texto del borrador", async () => {
    const h = setup();
    const shown = await h.show();
    const input = { original: shown, updated: { ...shown, bpm: "142" }, files: {}, artworkRemoved: false };
    expect(await h.editor.saveDrawer(input)).toEqual({ reading: "success", status: "ok", artworkRemoved: false });
    expect(h.requests.filter((r) => r.method === "PATCH")).toEqual([{
      method: "PATCH", path: "/catalog/v1/beats/g0", body: { expectedVersion: "1", patch: { bpm: "142" } },
    }]);
    expect(h.server.beats.get("g0")?.bpm).toBe("142");
    expect(await h.editor.saveDrawer(input)).toEqual({
      reading: "rejected", why: "conflict", message: "Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar.",
    });
    expect(h.creates()).toHaveLength(0);
    expect(h.server.directSent).toHaveLength(0);
  });

  it("Drawer quita portada antes del REPLACE incierto y devuelve pendiente parcial con el texto completo", async () => {
    const h = setup();
    const shown = await h.show();
    h.server.directState.faults.push("uncertain");
    expect(await h.editor.saveDrawer({
      original: shown, updated: { ...shown, bpm: "142", image_base64: null }, artworkRemoved: true, files: { MASTER: audio() },
    })).toEqual({
      reading: "pending", why: "uncertain", partial: true,
      message: "La portada se quitó y los metadatos se guardaron, pero los archivos no: La subida de «Beat 0» sigue confirmándose en el servidor. No se reenvía ni se borra nada: el beat aparecerá si se recibió; si no, se te avisará.",
    });
    expect(h.requests.slice(1, 4)).toEqual([
      { method: "PATCH", path: "/catalog/v1/beats/g0", body: { expectedVersion: "1", patch: { bpm: "142", artwork: null } } },
      { method: "GET", path: "/catalog/v1/beats/g0", body: null },
      expect.objectContaining({ method: "POST", path: "/catalog/v1/operations", body: expect.objectContaining({ kind: "REPLACE", expectedVersion: "2" }) }),
    ]);
    expect(h.server.directSent).toHaveLength(1);
  });

  it("X56: si la relectura falla tras quitar la portada, informa guardado parcial y no un error general", async () => {
    const h = setup({ readFailsAfterPatch: true });
    const shown = await h.show();
    const result = await h.editor.saveDrawer({
      original: shown, updated: { ...shown, bpm: "142", image_base64: null }, artworkRemoved: true, files: { MASTER: audio() },
    });
    expect(result).toMatchObject({ reading: "rejected", partial: true });
    expect((result as { message: string }).message).toMatch(/^La portada se quitó y los metadatos se guardaron, pero los archivos no: /);
    expect(h.creates()).toHaveLength(0);
    expect(h.server.directSent).toHaveLength(0);
  });

  it("guardado manual: usa la versión residente y devuelve el mensaje específico al quedar pendiente", async () => {
    const h = setup();
    const shown = await h.show();
    h.server.directState.faults.push("uncertain");
    expect(await h.editor.saveDrawer({ mode: "manual", updated: { ...shown, image_base64: "data:image/png;base64,iVBORw0KGgo=" } })).toEqual({
      reading: "pending", why: "uncertain", message: "La operación quedó en estado uncertain; el servidor conserva el resultado.",
    });
    expect(h.creates()).toEqual([expect.objectContaining({
      body: expect.objectContaining({ expectedVersion: "1", parts: [expect.objectContaining({ role: "ARTWORK" })] }),
    })]);
    expect(h.requests.filter((r) => r.method === "GET" && r.path === "/catalog/v1/beats/g0")).toHaveLength(1);
    expect(h.server.directSent).toHaveLength(1);
  });

  it("papelera: POST versionado, conflicto con aviso y éxito tras solicitarlo con la versión vigente", async () => {
    const h = setup();
    expect(await h.editor.trash([{ beatId: "g0", expectedVersion: "0" }])).toEqual({
      reading: "rejected", why: "conflict", message: "La biblioteca cambió en otro dispositivo; revisa antes de borrar.",
    });
    expect(h.server.beats.get("g0")?.state).toBe("ACTIVE");
    expect(await h.editor.trash([{ beatId: "g0", expectedVersion: "1" }])).toEqual({ reading: "success", status: "ok", artworkRemoved: false });
    expect(h.requests).toEqual(["0", "1"].map((expectedVersion) => ({
      method: "POST", path: "/catalog/v1/beats/trash", body: { items: [{ beatId: "g0", expectedVersion }] },
    })));
    expect(h.server.beats.get("g0")?.state).toBe("TRASH");
    expect(h.server.directSent).toHaveLength(0);
  });
});
