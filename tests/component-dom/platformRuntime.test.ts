import { describe, expect, it } from "vitest";

import { isDesktopRuntime } from "../../src/platform";

function runtimeWindow(url: string, internals?: unknown) {
  return {
    location: new URL(url) as unknown as Window["location"],
    __TAURI_INTERNALS__: internals,
  };
}

describe("platform runtime detection", () => {
  it("detects Desktop when Tauri internals are already injected", () => {
    expect(isDesktopRuntime(runtimeWindow("http://localhost:1420", {}))).toBe(true);
  });

  it("detects packaged Windows Tauri by its production origin before internals are observable", () => {
    expect(isDesktopRuntime(runtimeWindow("http://tauri.localhost"))).toBe(true);
  });

  it("detects the packaged custom Tauri protocol", () => {
    expect(isDesktopRuntime(runtimeWindow("tauri://localhost"))).toBe(true);
  });

  it("does not classify ordinary browser origins as Desktop", () => {
    expect(isDesktopRuntime(runtimeWindow("http://localhost:1420"))).toBe(false);
    expect(isDesktopRuntime(runtimeWindow("https://app.beatgaler.example"))).toBe(false);
  });
});
