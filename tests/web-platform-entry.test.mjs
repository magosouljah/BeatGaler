import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

for (const hasTauri of [false, true]) {
  test(`Web entry stays Web ${hasTauri ? "with" : "without"} Tauri globals`, async (context) => {
    const { window } = new JSDOM('<div id="root"></div>', { url: "https://beatgaler.test/" });
    window.fetch = () => { throw new Error("Unexpected network request in entry test"); };
    if (hasTauri) window.__TAURI_INTERNALS__ = {};
    globalThis.window = window;
    globalThis.document = window.document;
    context.after(() => {
      window.close();
      delete globalThis.window;
      delete globalThis.document;
    });

    let desktopLoads = 0;
    const vite = await createServer({
      mode: "web",
      envFile: false,
      server: { middlewareMode: true, watch: null, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [{
        name: "observe-platform-at-startup",
        enforce: "pre",
        transform(_code, id, options) {
          if (!options?.ssr) return;
          if (id.endsWith("/src/features/perf/startupTrace.ts")) {
            return "export function installStartupTrace() {}";
          }
          if (id.endsWith("/src/app/DesktopExperience.tsx")) {
            desktopLoads += 1;
            return `
              import { createElement } from "react";
              export default function DesktopExperience() { return createElement("output", null, "desktop"); }
            `;
          }
          if (id.endsWith("/src/app/WebExperience.tsx")) {
            return `
              import { createElement } from "react";
              import { isDesktopRuntime } from "../platform";
              import { usePlatform } from "../platform/react";
              export default function WebExperience() {
                return createElement("output", null, usePlatform().kind + ":" + isDesktopRuntime());
              }
            `;
          }
        },
      }],
    });

    try {
      await vite.ssrLoadModule("/src/main.tsx");
      const output = await new Promise((resolve, reject) => {
        const root = window.document.getElementById("root");
        const observer = new window.MutationObserver(readOutput);
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("The entry did not render either experience"));
        }, 3000);
        function readOutput() {
          const output = root.querySelector("output");
          if (!output) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve(output.textContent);
        }
        observer.observe(root, { childList: true, subtree: true });
        readOutput();
      });
      assert.equal(desktopLoads, 0, "Web startup requested DesktopExperience");
      assert.equal(output, "web:false");
    } finally {
      await vite.close();
    }
  });
}
