import { beforeEach, describe, expect, it } from "vitest";
import { normalizeRememberedWebCloudApi } from "../../src/features/auth/webCloudApiStartupGuard";

const API_KEY = "beatgaler:cloud-api:v1";

describe("Web Cloud API startup guard", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("migrates a remembered 127.0.0.1 Cloud API to the same-origin proxy", () => {
    localStorage.setItem(API_KEY, "http://127.0.0.1:4000");

    expect(normalizeRememberedWebCloudApi()).toBe(`${window.location.origin}/beatgaler-api`);
    expect(localStorage.getItem(API_KEY)).toBe(`${window.location.origin}/beatgaler-api`);
  });

  it("migrates a cross-origin localhost Cloud API to the same-origin proxy", () => {
    localStorage.setItem(API_KEY, "http://localhost:4000");

    expect(normalizeRememberedWebCloudApi()).toBe(`${window.location.origin}/beatgaler-api`);
    expect(localStorage.getItem(API_KEY)).toBe(`${window.location.origin}/beatgaler-api`);
  });

  it("preserves a non-loopback remembered Cloud API", () => {
    const remote = "https://cloud.example.test";
    localStorage.setItem(API_KEY, remote);

    expect(normalizeRememberedWebCloudApi()).toBe(remote);
    expect(localStorage.getItem(API_KEY)).toBe(remote);
  });

  it("does not rewrite storage inside Tauri", () => {
    localStorage.setItem(API_KEY, "http://127.0.0.1:4000");
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    expect(normalizeRememberedWebCloudApi()).toBeNull();
    expect(localStorage.getItem(API_KEY)).toBe("http://127.0.0.1:4000");
  });
});
