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

  it("keeps the earliest preconnect but requires current-origin cookie CSRF", () => {
    const main = source("src/main.tsx");
    const preconnect = source("src/features/playback/webRememberedDirectPreconnect.ts");
    const session = source("src/features/auth/webSessionBootstrap.ts");

    expect(main.indexOf("preconnectRememberedWebDirect();")).toBeLessThan(main.indexOf("ReactDOM.createRoot"));
    expect(preconnect).toContain("readWebCsrfCookieToken");
    expect(preconnect).toContain("const readWebCsrfToken = readWebCsrfCookieToken;");
    expect(session).toContain("export function readWebCsrfCookieToken(): string");
    expect(session.indexOf("const cookieToken = readWebCsrfCookieToken();")).toBeLessThan(
      session.indexOf("window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY)"),
    );
  });

  it("migrates a stale loopback Cloud API before Web fetch coordination or Direct preconnect", () => {
    const main = source("src/main.tsx");
    const normalizeIndex = main.indexOf("normalizeRememberedWebCloudApi();");
    const csrfIndex = main.indexOf("installWebCsrfFetchCoordinator();");
    const preconnectIndex = main.indexOf("preconnectRememberedWebDirect();");

    expect(main).toContain('import { normalizeRememberedWebCloudApi } from "./features/auth/webCloudApiStartupGuard";');
    expect(normalizeIndex).toBeGreaterThanOrEqual(0);
    expect(csrfIndex).toBeGreaterThan(normalizeIndex);
    expect(preconnectIndex).toBeGreaterThan(normalizeIndex);
  });

  it("keeps development Web API traffic on the verified same-origin proxy", () => {
    const vite = source("vite.config.ts");

    expect(vite).toContain('"/beatgaler-api": {');
    expect(vite).toContain('target: "http://127.0.0.1:4000"');
    expect(vite).toContain('requestPath.replace(/^\\/beatgaler-api/, "")');
  });
});
