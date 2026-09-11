import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API_KEY = "beatgaler:cloud-api:v1";
const WEB_SESSION_MARKER_KEY = "beatgaler:web-session-present:v1";
const STALE_LOOPBACK_API = "http://127.0.0.1:4000";

describe("Web Cloud API origin policy", () => {
  const originalFetch = window.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete (window as Window & { __beatgalerCredentialedFetchInstalled?: boolean }).__beatgalerCredentialedFetchInstalled;
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    delete (window as Window & { __beatgalerCredentialedFetchInstalled?: boolean }).__beatgalerCredentialedFetchInstalled;
    vi.doUnmock("../../src/platform");
  });

  it("migrates a stale loopback choice and sends Web auth through the same-origin proxy", async () => {
    const requestedUrls: string[] = [];
    const syncSession = vi.fn(async () => undefined);

    vi.doMock("../../src/platform", () => ({
      platform: {
        kind: "web",
        account: { getInstallationId: vi.fn(async () => "web-origin-policy-test") },
        cloudAuth: { syncSession },
        external: { openUrl: vi.fn(async () => undefined) },
      },
    }));

    window.localStorage.setItem(API_KEY, STALE_LOOPBACK_API);
    window.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url.endsWith("/auth/health")) {
        return new Response(JSON.stringify({ ok: true, account_auth: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({
          ok: true,
          session_transport: "cookie",
          csrf_token: "csrf-test",
          user: { id: "user-1", username: "origin#0001", storage_ready: true },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof window.fetch;

    const accountGate = await import("../../src/components/AccountGate");
    const expectedBase = `${window.location.origin}/beatgaler-api`;

    expect(accountGate.getResolvedCloudApiBase()).toBe(expectedBase);

    const user = await accountGate.loginBeatGalerAccount("origin@example.com", "password");

    expect(user.id).toBe("user-1");
    expect(window.localStorage.getItem(API_KEY)).toBe(expectedBase);
    expect(requestedUrls).toContain(`${expectedBase}/auth/health`);
    expect(requestedUrls).toContain(`${expectedBase}/auth/login`);
    expect(requestedUrls.some(url => url.startsWith(STALE_LOOPBACK_API))).toBe(false);
    expect(syncSession).toHaveBeenCalledWith(null, expectedBase);
  });
});
