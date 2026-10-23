import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  publishWebTransportIndex: vi.fn(),
  commitWebTransportIndexPointer: vi.fn(async () => undefined),
  readWebTransportIndexBootstrapState: vi.fn(async () => ({ pinned_message_id: null, bootstrap_pending: true })),
  reserveWebTransportBeat: vi.fn(async () => undefined),
  renewWebTransportBeat: vi.fn(async () => undefined),
  cancelWebTransportBeat: vi.fn(async () => undefined),
}));

const imports = vi.hoisted(() => ({
  commitWebImportedBeat: vi.fn(),
}));

vi.mock("../../src/features/cloud/webTransportController", () => ({ WebTransportController: class {} }));
vi.mock("../../src/features/cloud/webTransportWorkerClient", () => ({ WebTransportWorkerClient: class {} }));
vi.mock("../../src/features/cloud/webTransportSession", () => ({
  ...session,
  ensureWebTransportTopic: vi.fn(),
  reconcileWebTransportRouting: vi.fn(),
  purgeWebTransportTrash: vi.fn(),
  authorizeWebTransportProject: vi.fn(),
  uploadWebTransportProject: vi.fn(),
}));
vi.mock("../../src/features/import/webImportCommit", () => ({
  commitWebImportedBeat: imports.commitWebImportedBeat,
}));
import { WebGalerCloudTransport } from "../../src/features/cloud/webGalerCloudTransport";
import {
  commitWebTransportIndexPointer,
  publishWebTransportIndex,
  readWebTransportIndexBootstrapState,
  reserveWebTransportBeat,
} from "../../src/features/cloud/webTransportSession";
import { loadWebLibraryPage } from "../../src/features/library/webLibrary";

function harness(initial: {
  messageId: number;
  manifest: unknown;
  pointerRepair?: { expectedMessageId: number | null; source: "pin_recovery" | "history_recovery" };
} | null = null) {
  let current = initial;
  let tail = Promise.resolve();
  const worker = {
    getLibraryIndex: vi.fn(async () => {
      if (!current) throw new Error("Galer Cloud library index is still synchronizing.");
      return current;
    }),
    replaceLibraryIndex: vi.fn(async ({ manifest, expectedMessageId }) => {
      expect(expectedMessageId).toBe(0);
      expect(current).toBeNull();
      current = { messageId: 100, manifest };
      return { messageId: 100, previousMessageId: 0, beatCount: 0 };
    }),
  };
  const controller = {
    connect: vi.fn(async () => undefined),
    beginOperation: vi.fn(async () => ({ operationId: "op-import", sessionId: "session", generation: 1 })),
    endOperation: vi.fn(async () => undefined),
    withOperation: vi.fn((kind, scope, work) => {
      expect(kind).toBe("replace_index");
      expect(scope).toEqual({ objectType: "index", objectIds: ["pinned"] });
      const lease = { operationId: "op-index", sessionId: "session", generation: 1 };
      const next = tail.then(() => work(lease));
      tail = next.catch(() => {});
      return next;
    }),
  };
  const create = () => Object.assign(Object.create(WebGalerCloudTransport.prototype), {
    worker,
    controller,
    uploadCheckpoints: new Map(),
  }) as WebGalerCloudTransport;
  return { worker, controller, create };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(publishWebTransportIndex).mockReset();
  imports.commitWebImportedBeat.mockReset();
});

describe("Web initial INDEX through existing serialized operation", () => {
  it("rereads under the operation gate so two installations create one MASTER document", async () => {
    const h = harness();
    vi.mocked(publishWebTransportIndex).mockImplementationOnce(async ({ manifest, expectedMessageId }) => {
      await h.worker.replaceLibraryIndex({ manifest, expectedMessageId });
      return { messageId: 100, previousMessageId: 0, beatCount: 0 };
    });

    const results = await Promise.all([h.create().ensureLibraryIndex(), h.create().ensureLibraryIndex()]);

    expect(results.map(row => row.status).sort()).toEqual(["created", "existing"]);
    expect(results.map(row => row.messageId)).toEqual([100, 100]);
    expect(publishWebTransportIndex).toHaveBeenCalledOnce();
    expect(h.worker.replaceLibraryIndex).toHaveBeenCalledOnce();
    expect(h.worker.getLibraryIndex).toHaveBeenCalledWith(100);
    expect(commitWebTransportIndexPointer).toHaveBeenCalledWith({
      messageId: 100,
      expectedMessageId: 0,
      pointerSource: "publish",
      sourceId: "direct-bootstrap",
      beatCount: 0,
    });
  });

  it("returns the existing real manifest and never replaces it with an empty one", async () => {
    const manifest = { schema: "beatgaler.telegram.library", version: 2, beats: [{ id: "survives" }] };
    const h = harness({ messageId: 42, manifest });

    expect(await h.create().ensureLibraryIndex()).toEqual({ status: "existing", messageId: 42, manifest });
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
    expect(readWebTransportIndexBootstrapState).not.toHaveBeenCalled();
  });

  it("does not create an empty INDEX after a network error", async () => {
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("network timeout"));

    await expect(h.create().ensureLibraryIndex()).rejects.toThrow("network timeout");
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
  });

  it("publishes the empty MASTER INDEX before a first import reserves quota", async () => {
    const events: string[] = [];
    const h = harness();
    vi.mocked(publishWebTransportIndex).mockImplementationOnce(async ({ manifest, expectedMessageId }) => {
      events.push("master-index");
      await h.worker.replaceLibraryIndex({ manifest, expectedMessageId });
      return { messageId: 100, previousMessageId: 0, beatCount: 0 };
    });
    h.controller.beginOperation.mockImplementationOnce(async () => {
      events.push("commit-operation");
      return { operationId: "op-import", sessionId: "session", generation: 1 };
    });
    vi.mocked(reserveWebTransportBeat).mockImplementationOnce(async () => { events.push("reserve"); });
    imports.commitWebImportedBeat.mockImplementationOnce(async beat => {
      events.push("media-commit");
      return { beat, index: null };
    });

    const file = new File(["audio"], "first.mp3", { type: "audio/mpeg" });
    await h.create().commitImportedBeat({ id: "first" } as never, { master: file }, "test");

    expect(events).toEqual(["master-index", "commit-operation", "reserve", "media-commit"]);
  });

  it("bootstraps a fresh vault after pinned recovery returns BOT_METHOD_INVALID", async () => {
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: null, bootstrap_pending: true });
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    vi.mocked(publishWebTransportIndex).mockImplementationOnce(async ({ manifest, expectedMessageId }) => {
      await h.worker.replaceLibraryIndex({ manifest, expectedMessageId });
      return { messageId: 100, previousMessageId: 0, beatCount: 0 };
    });

    const observations: string[] = [];
    const page = await loadWebLibraryPage({
      getLibraryIndex: () => h.worker.getLibraryIndex(),
      ensureLibraryIndex: () => h.create().ensureLibraryIndex(),
    }, { onObservation: result => observations.push(result.state) });

    expect(page.beats).toEqual([]);
    expect(page.totalVisible).toBe(0);
    expect(observations).toEqual(["empty"]);
    expect(publishWebTransportIndex).toHaveBeenCalledOnce();
    expect(h.worker.replaceLibraryIndex).toHaveBeenCalledOnce();
    expect(h.worker.getLibraryIndex).toHaveBeenCalledWith(100);
    expect(commitWebTransportIndexPointer).toHaveBeenCalledWith({
      messageId: 100,
      expectedMessageId: 0,
      pointerSource: "publish",
      sourceId: "direct-bootstrap",
      beatCount: 0,
    });
  });

  it("fails closed for an existing vault with no pointer and no recoverable pin", async () => {
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: null, bootstrap_pending: false });
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));

    await expect(h.create().ensureLibraryIndex()).rejects.toThrow("BOT_METHOD_INVALID");
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
  });

  it("recovers an existing INDEX from Telegram's pin without publishing an empty one", async () => {
    const manifest = { schema: "beatgaler.telegram.library", version: 2, beats: [{ id: "survives" }], trash: [], deleted: [] };
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: 42, bootstrap_pending: false });
    const h = harness({ messageId: 42, manifest, pointerRepair: { expectedMessageId: null, source: "pin_recovery" } });
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));

    expect(await h.create().ensureLibraryIndex()).toEqual({ status: "existing", messageId: 42, manifest });
    expect(h.worker.getLibraryIndex).toHaveBeenLastCalledWith(42);
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
    expect(commitWebTransportIndexPointer).toHaveBeenCalledWith({
      messageId: 42,
      expectedMessageId: null,
      pointerSource: "pin_recovery",
      sourceId: "direct-index-recovery",
      beatCount: 1,
    });
  });

  it("does not bootstrap when Telegram's pinned message fails INDEX validation", async () => {
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: 42, bootstrap_pending: false });
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Pinned Telegram message is not a valid library INDEX."));

    await expect(h.create().ensureLibraryIndex()).rejects.toThrow("not a valid library INDEX");
    expect(h.worker.getLibraryIndex).toHaveBeenLastCalledWith(42);
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
  });
});
