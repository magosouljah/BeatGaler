// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const cookieSync = vi.hoisted(() => vi.fn(() => "csrf-cookie-old"));
vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "browser-cookie-session",
  resolveBeatGalerCloudApi: async () => "https://app.example.test/beatgaler-api",
}));
vi.mock("../../src/features/auth/webCsrfFetchCoordinator", () => ({
  syncWebCsrfSessionFromCookie: cookieSync,
}));

import { openBeatGalerPortal } from "../../src/components/billingPortal";

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("sends the restored session CSRF token when the visible cookie is older", async () => {
  sessionStorage.setItem("beatgaler:web-csrf:v1", "csrf-session-current");
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({
    portal: { url: "https://sandbox.polar.sh/customer-portal/session" },
  }) }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(openBeatGalerPortal()).resolves.toBe("https://sandbox.polar.sh/customer-portal/session");
  expect(fetchMock.mock.calls[0][1].headers["X-BeatGaler-CSRF"]).toBe("csrf-session-current");
  expect(cookieSync).not.toHaveBeenCalled();
});
