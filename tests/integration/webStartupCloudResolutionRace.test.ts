import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Web startup Cloud resolution race", () => {
  it("resolves the Cloud API inside every event ticket connection attempt", () => {
    const events = source("src/features/cloud/useCloudLibraryEvents.ts");
    const connectStart = events.indexOf("const connectEvents = async () => {");
    const resolveIndex = events.indexOf("const cloudBase = await resolveBeatGalerCloudApi();", connectStart);
    const ticketIndex = events.indexOf('fetch(`${cloudBase}/events/ticket`', connectStart);

    expect(events).not.toContain("const cloudBase = getResolvedCloudApiBase();");
    expect(resolveIndex).toBeGreaterThan(connectStart);
    expect(ticketIndex).toBeGreaterThan(resolveIndex);
  });

  it("keeps login prewarm off public startup and preserves current-origin cookie CSRF lookup", () => {
    const main = source("src/main.tsx");
    const session = source("src/features/auth/webSessionBootstrap.ts");

    expect(main).toContain("ReactDOM.createRoot");
    expect(main).not.toContain("preconnectRememberedWebDirect");
    expect(main).not.toContain("prewarmDirectRuntime");
    expect(session).toContain("export function readWebCsrfCookieToken(): string");
    expect(session.indexOf("const cookieToken = readWebCsrfCookieToken();")).toBeLessThan(
      session.indexOf("window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)"),
    );
  });

  it("keeps development Web API traffic on the verified same-origin proxy", () => {
    const vite = source("vite.config.ts");

    expect(vite).toContain('"/beatgaler-api": {');
    expect(vite).toContain('target: process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000"');
    expect(vite).toContain('requestPath.replace(/^\\/beatgaler-api/, "")');
  });
});
