import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_CSRF_SESSION_KEY } from "../../src/features/auth/webSessionBootstrap";
import { createWebCsrfCoordinatedFetch } from "../../src/features/auth/webCsrfFetchCoordinator";

describe("Web CSRF fetch coordinator", () => {
  let cookieHeader = "";

  beforeEach(() => {
    window.sessionStorage.clear();
    cookieHeader = "";
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => cookieHeader,
    });
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    delete (document as any).cookie;
    vi.restoreAllMocks();
  });

  it("reconciles a rotated cookie and retries CSRF_REQUIRED exactly once", async () => {
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "csrf-old");
    cookieHeader = "__Host-beatgaler_csrf=csrf-old";

    const delegate = vi.fn(async () => {
      if (delegate.mock.calls.length === 1) {
        // Simulate /auth/session applying Set-Cookie while this unsafe request
        // was already in flight with the previous header value.
        cookieHeader = "__Host-beatgaler_csrf=csrf-new";
        return new Response(JSON.stringify({ code: "CSRF_REQUIRED" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)).toBe("csrf-new");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof window.fetch;

    const coordinatedFetch = createWebCsrfCoordinatedFetch(delegate);
    const response = await coordinatedFetch("/beatgaler-api/transport/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beatgalerUserId: "web-installation" }),
    });

    expect(response.status).toBe(200);
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)).toBe("csrf-new");
  });

  it("does not retry a non-CSRF forbidden control-plane response", async () => {
    cookieHeader = "__Host-beatgaler_csrf=csrf-live";
    const delegate = vi.fn(async () => new Response(JSON.stringify({ code: "FORBIDDEN" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof window.fetch;

    const response = await createWebCsrfCoordinatedFetch(delegate)(
      "/beatgaler-api/transport/session/start",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(403);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("classifies an event-ticket 403 as event-sync degradation without changing transport semantics", async () => {
    cookieHeader = "__Host-beatgaler_csrf=csrf-live";
    const delegate = vi.fn(async () => new Response(JSON.stringify({
      code: "EVENT_AUTH_FORBIDDEN",
      error: "BeatGaler event authorization failed.",
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof window.fetch;
    const statuses: unknown[] = [];
    const onStatus = (event: Event) => statuses.push((event as CustomEvent).detail);
    window.addEventListener("beatgaler:event-sync-status", onStatus);

    const response = await createWebCsrfCoordinatedFetch(delegate)(
      "/beatgaler-api/events/ticket",
      { method: "POST", body: JSON.stringify({ beatgalerUserId: "web-installation" }) },
    );
    const body = await response.json();

    window.removeEventListener("beatgaler:event-sync-status", onStatus);
    expect(response.status).toBe(200);
    expect(body.ticket).toBeNull();
    expect(body.event_sync_status).toBe("degraded");
    expect(statuses).toEqual([{
      state: "degraded",
      source: "event_ticket",
      status: 403,
      code: "EVENT_AUTH_FORBIDDEN",
    }]);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("preserves real network failures for the existing offline/poor reachability path", async () => {
    const networkError = new TypeError("Failed to fetch");
    const delegate = vi.fn(async () => { throw networkError; }) as unknown as typeof window.fetch;

    await expect(createWebCsrfCoordinatedFetch(delegate)(
      "/beatgaler-api/events/ticket",
      { method: "POST", body: "{}" },
    )).rejects.toBe(networkError);
    expect(delegate).toHaveBeenCalledTimes(1);
  });
});
