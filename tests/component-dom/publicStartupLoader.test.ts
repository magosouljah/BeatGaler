// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import WebExperience from "../../src/app/WebExperience";

const renderAuth = vi.hoisted(() => vi.fn(() => null));
vi.mock("../../src/app/WebGalleryEntry", () => ({ default: renderAuth }));

describe("public startup overlay", () => {
  it("dismisses when the Landing renders without waiting for an account or library", async () => {
    const html = readFileSync("index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    const loader = page.getElementById("beatgaler-startup-loader")!;
    const host = page.getElementById("root")!;
    const startupScript = page.querySelector("body script:not([src])")!;
    const originalUrl = window.location.href;
    document.body.append(loader, host);
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const root = createRoot(host);
    try {
      new Function(startupScript.textContent!)();
      host.append(document.createElement("main"));
      await Promise.resolve();
      expect(document.getElementById(loader.id)).toBe(loader);
      host.replaceChildren();

      await act(async () => {
        await import("../../src/features/design/LANDING/LandingPage");
        root.render(createElement(WebExperience));
      });

      expect(host.querySelector("h1")?.textContent).toBe("BeatGaler");
      expect(renderAuth).not.toHaveBeenCalled();
      expect(document.getElementById(loader.id)).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      loader.remove();
      window.history.replaceState(null, "", originalUrl);
      canvasContext.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
