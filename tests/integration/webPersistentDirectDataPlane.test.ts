import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "test-token",
  getResolvedCloudApiBase: () => "https://cloud.test",
}));
vi.mock("../../src/platform/webClientId", () => ({ getWebClientId: () => "persistent-browser" }));

import { loadWebLibrary } from "../../src/features/library/webLibrary";
import { reconcileWebTransportRouting } from "../../src/features/cloud/webTransportSession";

afterEach(() => vi.unstubAllGlobals());

describe("persistent Direct data-plane boundary", () => {
  it("bootstraps missing Web INDEX through the active transport, with no Cloud upload", async () => {
    const fetch = vi.fn(() => { throw new Error("Cloud INDEX bytes forbidden"); });
    vi.stubGlobal("fetch", fetch);
    const transport = {
      getLibraryIndex: vi.fn().mockRejectedValue(new Error("Galer Cloud library index is still synchronizing.")),
      ensureLibraryIndex: vi.fn().mockResolvedValue({ messageId: 91, manifest: { schema: "beatgaler.telegram.library", version: 2, beats: [], trash: [], deleted: [] } }),
      downloadFiles: vi.fn(),
    };
    await expect(loadWebLibrary(transport)).resolves.toEqual([]);
    expect(transport.ensureLibraryIndex).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only message routing metadata to Cloud, never the authoritative INDEX", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetch);
    await reconcileWebTransportRouting({
      schema: "beatgaler.telegram.library", version: 2,
      beats: [{ id: "beat-A", name: "private title", master: { telegram_file_id: "direct:77" }, artwork: { bytes: "private artwork" }, files: [{ bytes: "WAV bytes" }] }],
      trash: [{ private: "deleted metadata" }], deleted: [],
    });
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toBe("https://cloud.test/transport/routing/reconcile");
    expect(JSON.parse(String(request[1].body))).toEqual({ beatgalerUserId: "persistent-browser", routingSnapshot: { "beat-A": 77 } });
  });
});
