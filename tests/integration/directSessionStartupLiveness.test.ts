import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

// M10: el orden restore→start, el timeout de control y la invalidación tras inicializar el plano de datos
// ahora se prueban por comportamiento en tests/component-dom/webTransportSession.test.ts y
// webTransportWorkerClient.test.ts. Queda solo la parte de cloud-server (tanda de cloud-server de M10).
describe("Direct session startup liveness", () => {
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
