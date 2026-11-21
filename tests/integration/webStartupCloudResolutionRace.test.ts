import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Web startup Cloud resolution race", () => {
  it("resolves the Cloud API before Direct opens a transport session", () => {
    const coordinator = source("src/features/playback/webStartupPlaybackCoordinator.ts");
    const resolveIndex = coordinator.indexOf("await resolveBeatGalerCloudApi();");
    const connectIndex = coordinator.indexOf("await this.transport.connectPlaybackDataPlane();");

    expect(coordinator).toContain('import { resolveBeatGalerCloudApi } from "../../components/AccountGate";');
    expect(resolveIndex).toBeGreaterThanOrEqual(0);
    expect(connectIndex).toBeGreaterThan(resolveIndex);
  });

  it("resolves the Cloud API inside every event ticket connection attempt", () => {
    const events = source("src/features/cloud/useCloudLibraryEvents.ts");
    const connectStart = events.indexOf("const connectEvents = async () => {");
    const resolveIndex = events.indexOf("const cloudBase = await resolveBeatGalerCloudApi();", connectStart);
    const ticketIndex = events.indexOf('fetch(`${cloudBase}/events/ticket`', connectStart);

    expect(events).not.toContain("const cloudBase = getResolvedCloudApiBase();");
    expect(resolveIndex).toBeGreaterThan(connectStart);
    expect(ticketIndex).toBeGreaterThan(resolveIndex);
  });

  // Antes comparaba índices y pasaba en vacío (-1 < n) aunque el arranque ya no preconecta; el arranque público no abre Direct.
  it("keeps remembered preconnect off public startup and requires current-origin cookie CSRF", () => {
    const main = source("src/main.tsx");
    const preconnect = source("src/features/playback/webRememberedDirectPreconnect.ts");
    const session = source("src/features/auth/webSessionBootstrap.ts");

    expect(main).toContain("ReactDOM.createRoot");
    expect(main).not.toContain("preconnectRememberedWebDirect");
    expect(preconnect).toContain("readWebCsrfCookieToken");
    expect(preconnect).toContain("const readWebCsrfToken = readWebCsrfCookieToken;");
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
