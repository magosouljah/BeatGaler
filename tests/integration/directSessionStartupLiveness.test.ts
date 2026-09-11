import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Direct session startup liveness", () => {
  it("waits for the shared Web account restore before reserving Direct", () => {
    const session = source("src/features/cloud/webTransportSession.ts");
    const reserveStart = session.indexOf("export async function reserveWebTransportSession");
    const restore = session.indexOf("await restoreBeatGalerSession();", reserveStart);
    const directStart = session.indexOf('transportRequest<WebTransportSessionPublic>("/transport/session/start"', reserveStart);

    expect(session).toContain("restoreBeatGalerSession");
    expect(reserveStart).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(reserveStart);
    expect(directStart).toBeGreaterThan(restore);
  });

  it("bounds browser control-plane requests so controller singleflight can settle", () => {
    const session = source("src/features/cloud/webTransportSession.ts");

    expect(session).toContain("WEB_TRANSPORT_CONTROL_REQUEST_TIMEOUT_MS = 70_000");
    expect(session).toContain("const controller = new AbortController();");
    expect(session).toContain("signal: controller.signal");
    expect(session).toContain("Galer Cloud transport control request timed out.");
    expect(session).toContain("clearTimeout(timeoutId);");
  });

  it("bounds productive temporary-auth response transformation and formerly unbounded setup steps", () => {
    const boundary = source("cloud-server/productive-temp-auth-boundary.js");

    expect(boundary).toContain("const BOUNDARY_TIMEOUT_MS = 65_000;");
    expect(boundary).toContain('timeout(loadMtcuteInternals(), "mtcute internals load")');
    expect(boundary).toContain('timeout(makeCrypto(m), "temporary auth crypto initialization")');
    expect(boundary).toContain("transformTransportBody(req, body)");
    expect(boundary).toContain("BOUNDARY_TIMEOUT_MS");
    expect(boundary).toContain("Temporary transport authorization is unavailable.");
  });
});
