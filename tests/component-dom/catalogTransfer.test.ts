// T12 — Cliente de transferencias por capacidad: SHA-256 incremental, capacidad → PUT con reintento solo ante rechazo sin efecto
// (Retry-After, nueva capacidad, misma parte), nunca reenvío tras 202/PART_UNCERTAIN, reselección distinta → error, commit con
// observación hasta estado terminal. Sin red: fetch inyectado.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { Sha256, createCatalogTransfer, describePart, sha256Hex } from "../../src/features/library/catalog/catalogTransfer";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function fakeFetch(handler: (call: Call, n: number) => { status: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body };
    calls.push(call);
    const r = handler(call, calls.length);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const waits: number[] = [];
const mk = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => createCatalogTransfer({ fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "csrf-1", headers: () => ({ era: "e1", epoch: "7" }), sleep: async (ms) => { waits.push(ms); }, pollIntervalMs: 1, idempotencyKey: () => "idem-1", ...over });
const TOKEN = "T".repeat(43);
const cap = (attempt: number, size = 3) => ({ operationId: "top-1", partKey: "m0", token: TOKEN, expiresAt: "2026-11-09T00:10:00Z", attempt, uploadPath: `/catalog/v1/transfer/upload/${TOKEN}`, method: "PUT", declaredSize: String(size), declaredSha256: null, singleUse: true });
const op = (status: string, extra: Record<string, unknown> = {}) => ({ operationId: "top-1", kind: "IMPORT", status, beatId: "b-1", parts: [], progress: { total: 1, verified: 0, receipts: 0 }, reservation: null, result: null, lastError: null, ...extra });

describe("catalogTransfer", () => {
  it("SHA-256 incremental: vectores conocidos, fronteras de bloque y Blob por trozos coinciden con node:crypto", async () => {
    expect(new Sha256().update(new Uint8Array(0)).digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const n of [55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
      const bytes = new Uint8Array(n); for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(new Sha256().update(bytes).digestHex()).toBe(expected);
      // actualización troceada irregular
      const h = new Sha256(); let off = 0; let step = 1; while (off < n) { h.update(bytes.subarray(off, Math.min(n, off + step))); off += step; step = (step * 3) % 97 + 1; }
      expect(h.digestHex()).toBe(expected);
    }
    // Blob por trozos (jsdom acepta partes string; los bytes UTF-8 se comparan con node:crypto)
    for (const n of [0, 1, 999, 1000, 1001, 100_003]) {
      const text = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      expect(await sha256Hex(new Blob([text]), 1000)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
    const part = await describePart(new Blob(["abc"], { type: "audio/mpeg" }), { partKey: "m0", slotKey: "MASTER", role: "MASTER", filename: "a.mp3" });
    expect(part).toEqual({ partKey: "m0", slotKey: "MASTER", role: "MASTER", partIndex: 0, size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", filename: "a.mp3", mime: "audio/mpeg" });
  });

  it("createOperation envía Idempotency-Key, era/época, CSRF y bearer; uploadPart sin puerto directo → DIRECT_UNAVAILABLE sin ninguna llamada (E77: el Cloud no recibe bytes)", async () => {
    const blob = new Blob([new TextEncoder().encode("abc")], { type: "audio/mpeg" });
    const f = fakeFetch((c) => (c.url.endsWith("/catalog/v1/operations") ? { status: 201, body: op("PREPARED", { created: true }) } : { status: 404, body: { code: "NOT_FOUND" } }));
    const t = mk(f.fetchImpl);
    const created = await t.createOperation({ kind: "IMPORT", parts: [{ partKey: "m0", slotKey: "MASTER", role: "MASTER", partIndex: 0, size: 3, sha256: null }], metadata: { name: "x" } });
    expect(created.created).toBe(true);
    const h0 = f.calls[0].headers;
    expect([h0["Idempotency-Key"], h0["X-Catalog-Era"], h0["X-Catalog-Epoch"], h0["X-BeatGaler-CSRF"], h0.Authorization]).toEqual(["idem-1", "e1", "7", "csrf-1", "Bearer tok"]);
    await expect(t.uploadPart({ operationId: "top-1", partKey: "m0", blob })).rejects.toMatchObject({ status: 503, code: "DIRECT_UNAVAILABLE", detail: { reason: "NO_DIRECT" } });
    expect(f.calls).toHaveLength(1); // solo la creación de la operación: ni capacidad, ni PUT de bytes
    expect(Object.keys(t).sort()).toEqual(["cancel", "commit", "createOperation", "getOperation", "renewReservation", "uploadPart"]); // sin issueCapability ni uploadProject
  });

  it("commit: 200 → COMMITTED, 202 → observar hasta COMMITTED, VERSION_CONFLICT → CONFLICT con error", async () => {
    const f1 = fakeFetch(() => ({ status: 200, body: op("COMMITTED", { result: { beatId: "b-1", version: "1", revision: "3" } }) }));
    expect((await mk(f1.fetchImpl).commit("top-1")).status).toBe("COMMITTED");
    const seq = ["VERIFYING", "VERIFYING", "READY"]; let i = 0;
    const f2 = fakeFetch((c) => {
      if (c.method === "POST" && c.url.endsWith("/commit")) return i < 3 ? { status: 202, body: op("VERIFYING", { pending: ["m0"] }) } : { status: 200, body: op("COMMITTED") };
      return { status: 200, body: op(seq[Math.min(i++, seq.length - 1)]) };
    });
    const r2 = await mk(f2.fetchImpl).commit("top-1");
    expect(r2.status).toBe("COMMITTED");
    expect(f2.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "GET", "POST"]);
    const f3 = fakeFetch((c) => (c.method === "POST" ? { status: 409, body: { error: "v", code: "VERSION_CONFLICT", detail: { current_version: "2", expected_version: "1" } } } : { status: 200, body: op("CONFLICT", { lastError: "VERSION_CONFLICT" }) }));
    const r3 = await mk(f3.fetchImpl).commit("top-1");
    expect(r3.status).toBe("CONFLICT");
    if (r3.status === "CONFLICT") expect(r3.error).toBeInstanceOf(CatalogApiError);
    const f4 = fakeFetch((c) => (c.method === "POST" ? { status: 202, body: op("VERIFYING") } : { status: 200, body: op("VERIFYING") }));
    const r4 = await mk(f4.fetchImpl, { maxPollMs: 0 }).commit("top-1");
    expect(r4.status).toBe("TIMEOUT");
  });
});
