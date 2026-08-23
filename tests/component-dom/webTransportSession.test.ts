// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/webClientId", () => ({
  getWebClientId: () => "beatgaler-web-browser-test",
}));

vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "test-token",
  getResolvedCloudApiBase: () => "https://cloud.test",
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
