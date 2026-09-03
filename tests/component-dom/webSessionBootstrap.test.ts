import { beforeEach, describe, expect, it } from "vitest";
import {
  WEB_CSRF_SESSION_KEY,
  readWebCookieValue,
  readWebCsrfToken,
} from "../../src/features/auth/webSessionBootstrap";

describe("remembered Web session bootstrap", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("reads the persisted __Host CSRF cookie without decoding unrelated cookies", () => {
    expect(readWebCookieValue("a=1; __Host-beatgaler_csrf=csrf%2Dvalue; b=2", "__Host-beatgaler_csrf"))
      .toBe("csrf-value");
  });

  it("returns empty when the requested cookie is absent", () => {
    expect(readWebCookieValue("a=1; b=2", "__Host-beatgaler_csrf")).toBe("");
  });

  it("prefers the live CSRF cookie over a stale sessionStorage token", () => {
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "stale-session-token");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      value: "__Host-beatgaler_csrf=live-cookie-token",
    });

    expect(readWebCsrfToken()).toBe("live-cookie-token");

    delete (document as Document & { cookie?: string }).cookie;
  });

  it("falls back to sessionStorage when the CSRF cookie is not visible", () => {
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, "session-fallback");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      value: "other=value",
    });

    expect(readWebCsrfToken()).toBe("session-fallback");

    delete (document as Document & { cookie?: string }).cookie;
  });
});
