import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  publishWebTransportIndex: vi.fn(),
  commitWebTransportIndexPointer: vi.fn(async () => undefined),
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
  reserveWebTransportBeat,
} from "../../src/features/cloud/webTransportSession";

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
});
