import { describe, expect, it } from "vitest";
import { readWebCookieValue } from "../../src/features/auth/webSessionBootstrap";

describe("remembered Web session bootstrap", () => {
  it("reads the persisted __Host CSRF cookie without decoding unrelated cookies", () => {
    expect(readWebCookieValue("a=1; __Host-beatgaler_csrf=csrf%2Dvalue; b=2", "__Host-beatgaler_csrf"))
      .toBe("csrf-value");
  });

  it("returns empty when the requested cookie is absent", () => {
    expect(readWebCookieValue("a=1; b=2", "__Host-beatgaler_csrf")).toBe("");
  });
});
