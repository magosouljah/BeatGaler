import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/features/cloud/webTransportController", () => ({ WebTransportController: class {} }));
vi.mock("../../src/features/cloud/webTransportWorkerClient", () => ({ WebTransportWorkerClient: class {} }));
vi.mock("../../src/features/cloud/webTransportSession", () => ({
  commitWebTransportIndexPointer: vi.fn(async () => undefined),
  ensureWebTransportTopic: vi.fn(), reconcileWebTransportRouting: vi.fn(),
}));
import { WebGalerCloudTransport } from "../../src/features/cloud/webGalerCloudTransport";
import { commitWebTransportIndexPointer } from "../../src/features/cloud/webTransportSession";

function harness(initial: { messageId: number; manifest: unknown } | null = null) {
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
    withOperation: vi.fn((kind, scope, work) => {
      expect(kind).toBe("replace_index"); expect(scope).toEqual({ objectType: "index", objectIds: ["pinned"] });
      const next = tail.then(work); tail = next.catch(() => {}); return next;
    }),
  };
  const create = () => Object.assign(Object.create(WebGalerCloudTransport.prototype), { worker, controller }) as WebGalerCloudTransport;
  return { worker, controller, create };
}

describe("Web initial INDEX through existing serialized Direct operation", () => {
  it("rereads under the operation gate so two installations create one document", async () => {
    vi.mocked(commitWebTransportIndexPointer).mockClear();
    const h = harness();
    const results = await Promise.all([h.create().ensureLibraryIndex(), h.create().ensureLibraryIndex()]);
    expect(results.map(row => row.status).sort()).toEqual(["created", "existing"]);
    expect(results.map(row => row.messageId)).toEqual([100, 100]);
    expect(h.worker.replaceLibraryIndex).toHaveBeenCalledOnce();
    expect(commitWebTransportIndexPointer).toHaveBeenCalledWith({ messageId: 100, sourceId: "direct-bootstrap", beatCount: 0 });
  });
  it("returns the existing real manifest and never replaces it with an empty one", async () => {
    const manifest = { schema: "beatgaler.telegram.library", version: 2, beats: [{ id: "survives" }] };
    const h = harness({ messageId: 42, manifest });
    expect(await h.create().ensureLibraryIndex()).toEqual({ status: "existing", messageId: 42, manifest });
    expect(h.worker.replaceLibraryIndex).not.toHaveBeenCalled();
  });
  it("does not create an empty INDEX after a network error", async () => {
    const h = harness(); h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("network timeout"));
    await expect(h.create().ensureLibraryIndex()).rejects.toThrow("network timeout");
    expect(h.worker.replaceLibraryIndex).not.toHaveBeenCalled();
  });
});
