import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/features/cloud/webTransportController", () => ({ WebTransportController: class {} }));
vi.mock("../../src/features/cloud/webTransportWorkerClient", () => ({ WebTransportWorkerClient: class {} }));
vi.mock("../../src/features/cloud/webTransportSession", () => ({
  commitWebTransportIndexPointer: vi.fn(async () => undefined),
  readWebTransportIndexBootstrapState: vi.fn(async () => ({ pinned_message_id: null, bootstrap_pending: true })),
  publishWebTransportIndex: vi.fn(),
  ensureWebTransportTopic: vi.fn(), reconcileWebTransportRouting: vi.fn(),
}));
import { WebGalerCloudTransport } from "../../src/features/cloud/webGalerCloudTransport";
import { commitWebTransportIndexPointer, publishWebTransportIndex, readWebTransportIndexBootstrapState } from "../../src/features/cloud/webTransportSession";
import { loadWebLibraryPage } from "../../src/features/library/webLibrary";

function harness(initial: { messageId: number; manifest: unknown } | null = null) {
  let current = initial;
  let tail = Promise.resolve();
  vi.mocked(publishWebTransportIndex).mockClear();
  vi.mocked(publishWebTransportIndex).mockImplementation(async ({ manifest, expectedMessageId }) => {
    expect(expectedMessageId).toBe(0);
    expect(current).toBeNull();
    current = { messageId: 100, manifest };
    return { messageId: 100, previousMessageId: 0, beatCount: 0 };
  });
  const worker = {
    getLibraryIndex: vi.fn(async () => {
      if (!current) throw new Error("Galer Cloud library index is still synchronizing.");
      return current;
    }),
  };
  const controller = {
    withOperation: vi.fn((kind, scope, work) => {
      expect(kind).toBe("replace_index"); expect(scope).toEqual({ objectType: "index", objectIds: ["pinned"] });
      const next = tail.then(() => work({})); tail = next.catch(() => {}); return next;
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
    expect(publishWebTransportIndex).toHaveBeenCalledOnce();
    expect(h.worker.getLibraryIndex).toHaveBeenCalledWith(100);
    expect(commitWebTransportIndexPointer).toHaveBeenCalledWith({ messageId: 100, expectedMessageId: 0, pointerSource: "publish", sourceId: "direct-bootstrap", beatCount: 0 });
  });
  it("returns the existing real manifest and never replaces it with an empty one", async () => {
    vi.mocked(readWebTransportIndexBootstrapState).mockClear();
    const manifest = { schema: "beatgaler.telegram.library", version: 2, beats: [{ id: "survives" }] };
    const h = harness({ messageId: 42, manifest });
    expect(await h.create().ensureLibraryIndex()).toEqual({ status: "existing", messageId: 42, manifest });
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
    expect(readWebTransportIndexBootstrapState).not.toHaveBeenCalled();
  });
  it("does not create an empty INDEX after a network error", async () => {
    const h = harness(); h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("network timeout"));
    await expect(h.create().ensureLibraryIndex()).rejects.toThrow("network timeout");
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
  });
  it("bootstraps a fresh vault after pinned recovery returns BOT_METHOD_INVALID", async () => {
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: null, bootstrap_pending: true });
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    const observations: string[] = [];
    const page = await loadWebLibraryPage({
      getLibraryIndex: () => h.worker.getLibraryIndex(),
      ensureLibraryIndex: () => h.create().ensureLibraryIndex(),
    }, { onObservation: result => observations.push(result.state) });
    expect(page.beats).toEqual([]);
    expect(page.totalVisible).toBe(0);
    expect(observations).toEqual(["empty"]);
    expect(publishWebTransportIndex).toHaveBeenCalledOnce();
    expect(h.worker.getLibraryIndex).toHaveBeenCalledWith(100);
  });
  it("fails closed for an existing vault with no pointer and no recoverable pin", async () => {
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: null, bootstrap_pending: false });
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    await expect(h.create().ensureLibraryIndex()).rejects.toThrow("BOT_METHOD_INVALID");
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
  });
  it("recovers an existing INDEX from Telegram's pin without publishing an empty one", async () => {
    const manifest = { schema: "beatgaler.telegram.library", version: 2, beats: [{ id: "survives" }], trash: [], deleted: [] };
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: 42, bootstrap_pending: false });
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    h.worker.getLibraryIndex.mockResolvedValueOnce({ messageId: 42, manifest, pointerRepair: { expectedMessageId: null, source: "pin_recovery" } } as any);
    expect(await h.create().ensureLibraryIndex()).toEqual({ status: "existing", messageId: 42, manifest });
    expect(h.worker.getLibraryIndex).toHaveBeenLastCalledWith(42);
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
  });
  it("does not bootstrap when Telegram's pinned message fails INDEX validation", async () => {
    vi.mocked(readWebTransportIndexBootstrapState).mockResolvedValueOnce({ pinned_message_id: 42, bootstrap_pending: false });
    const h = harness();
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Telegram API error 400: BOT_METHOD_INVALID"));
    h.worker.getLibraryIndex.mockRejectedValueOnce(new Error("Pinned Telegram message is not a valid library INDEX."));
    await expect(h.create().ensureLibraryIndex()).rejects.toThrow("not a valid library INDEX");
    expect(publishWebTransportIndex).not.toHaveBeenCalled();
  });
});
