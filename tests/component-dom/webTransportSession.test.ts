// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/webClientId", () => ({
  getWebClientId: () => "beatgaler-web-browser-test",
}));

vi.mock("../../src/features/auth/webSession", () => ({
  getBeatGalerAuthToken: () => "test-token",
  getResolvedCloudApiBase: () => "https://cloud.test",
  restoreBeatGalerSession: vi.fn(async () => ({ id: 'test-user' })),
}));

import { webTransportRequestBody } from "../../src/features/cloud/webTransportSession";

describe("Web transport control-plane identity", () => {
  it("attaches the authorized browser installation id to every request body", () => {
    expect(webTransportRequestBody({ sessionId: "session-1", generation: 2 })).toEqual({
      sessionId: "session-1",
      generation: 2,
      beatgalerUserId: "beatgaler-web-browser-test",
    });
  });

  it("does not allow a caller to override the browser installation id", () => {
    expect(webTransportRequestBody({ beatgalerUserId: "foreign-installation" })).toEqual({
      beatgalerUserId: "beatgaler-web-browser-test",
    });
  });
});

describe("Web transport control-plane liveness (M10: comportamiento)", () => {
  it("restores the shared Web account before the Direct session start request", async () => {
    const order: string[] = [];
    const web = await import("../../src/features/auth/webSession");
    vi.mocked(web.restoreBeatGalerSession).mockImplementationOnce(async () => {
      order.push("restore");
      return { id: "test-user" } as never;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      order.push("start");
      return new Response(JSON.stringify({ error: "stop here" }), { status: 400 });
    }));
    try {
      const { reserveWebTransportSession } = await import("../../src/features/cloud/webTransportSession");
      await expect(reserveWebTransportSession()).rejects.toThrow("stop here");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(order).toEqual(["restore", "start"]);
  });

  it("aborts a control request that never answers so singleflight callers can settle", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }));
    try {
      const { catalogDirectControlRequest } = await import("../../src/features/cloud/webTransportSession");
      const request = catalogDirectControlRequest("/transport/session/heartbeat", {});
      const rejection = expect(request).rejects.toThrow("Galer Cloud transport control request timed out.");
      await vi.advanceTimersByTimeAsync(69_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await rejection;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
