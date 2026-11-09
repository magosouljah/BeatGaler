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

  it("createOperation envía Idempotency-Key, era/época, CSRF y bearer; uploadPart: capacidad → PUT 503 SEND_REJECTED (Retry-After) → espera → nueva capacidad → PUT 200 RECEIPT", async () => {
    waits.length = 0;
    const blob = new Blob([new TextEncoder().encode("abc")], { type: "audio/mpeg" });
    let caps = 0;
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/catalog/v1/operations")) return { status: 201, body: op("PREPARED", { created: true }) };
      if (c.url.endsWith("/capability")) return { status: 201, body: cap(++caps) };
      if (c.url.includes("/transfer/upload/")) return caps === 1 ? { status: 503, body: { error: "flood", code: "SEND_REJECTED", detail: { retry_after_ms: 7000, same_identity: true } }, headers: { "retry-after": "7" } } : { status: 200, body: op("VERIFYING", { upload: { state: "RECEIPT", partKey: "m0", attempt: 2, bytesSha256: "x", level: "GATEWAY", verification: "PENDING_PROVIDER" } }) };
      return { status: 404, body: { code: "NOT_FOUND" } };
    });
    const t = mk(f.fetchImpl);
    const created = await t.createOperation({ kind: "IMPORT", parts: [{ partKey: "m0", slotKey: "MASTER", role: "MASTER", partIndex: 0, size: 3, sha256: null }], metadata: { name: "x" } });
    expect(created.created).toBe(true);
    const h0 = f.calls[0].headers;
    expect([h0["Idempotency-Key"], h0["X-Catalog-Era"], h0["X-Catalog-Epoch"], h0["X-BeatGaler-CSRF"], h0.Authorization]).toEqual(["idem-1", "e1", "7", "csrf-1", "Bearer tok"]);
    const r = await t.uploadPart({ operationId: "top-1", partKey: "m0", blob });
    expect(r.state).toBe("RECEIPT"); expect(r.attempt).toBe(2);
    expect(f.calls.map((c) => `${c.method} ${c.url.replace("https://cloud.invalid/api", "")}`)).toEqual(["POST /catalog/v1/operations", "POST /catalog/v1/operations/top-1/parts/m0/capability", `PUT /catalog/v1/transfer/upload/${TOKEN}`, "POST /catalog/v1/operations/top-1/parts/m0/capability", `PUT /catalog/v1/transfer/upload/${TOKEN}`]);
    expect(waits).toEqual([7000]);
    const put = f.calls[2];
    expect(put.body).toBe(blob); expect(put.headers["Content-Type"]).toBe("audio/mpeg"); expect(put.headers["X-Catalog-Era"]).toBe("e1");
    expect(Object.keys(put.headers).some((k) => /telegram|token|chat/i.test(k))).toBe(false);
  });

  it("202 UNCERTAIN y 409 PART_UNCERTAIN → sin reenvío (una sola capacidad); PART_BYTES_MISMATCH / permanente / capacidad inválida → error sin reintento; agotar intentos → último error", async () => {
    waits.length = 0;
    const blob = new Blob([new TextEncoder().encode("abc")]);
    const f1 = fakeFetch((c) => (c.url.endsWith("/capability") ? { status: 201, body: cap(1) } : { status: 202, body: op("TRANSFERRING", { upload: { state: "UNCERTAIN", reconcile: true, resend: "BLOCKED" } }) }));
    const r1 = await mk(f1.fetchImpl).uploadPart({ operationId: "top-1", partKey: "m0", blob });
    expect(r1.state).toBe("UNCERTAIN"); expect(f1.calls.length).toBe(2);
    const f2 = fakeFetch((c) => (c.url.endsWith("/capability") ? { status: 409, body: { error: "u", code: "PART_UNCERTAIN", detail: { reconcile: true } } } : { status: 200, body: op("TRANSFERRING") }));
    const r2 = await mk(f2.fetchImpl).uploadPart({ operationId: "top-1", partKey: "m0", blob });
    expect(r2.state).toBe("UNCERTAIN"); expect(f2.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    for (const [code, status] of [["PART_BYTES_MISMATCH", 409], ["SEND_REJECTED_PERMANENT", 403], ["CAPABILITY_EXPIRED", 403], ["CREDENTIAL_REVOKED", 503]] as const) {
      const f = fakeFetch((c) => (c.url.endsWith("/capability") ? { status: 201, body: cap(1) } : { status, body: { error: code, code, detail: {} } }));
      await expect(mk(f.fetchImpl).uploadPart({ operationId: "top-1", partKey: "m0", blob })).rejects.toMatchObject({ code, status });
      expect(f.calls.length).toBe(2);
    }
    // tamaño declarado distinto del archivo reseleccionado: error antes de enviar un byte
    const f3 = fakeFetch(() => ({ status: 201, body: cap(1, 999) }));
    await expect(mk(f3.fetchImpl).uploadPart({ operationId: "top-1", partKey: "m0", blob })).rejects.toMatchObject({ code: "PART_BYTES_MISMATCH" });
    expect(f3.calls.length).toBe(1);
    // rechazos sin efecto hasta agotar intentos
    let n = 0;
    const f4 = fakeFetch((c) => (c.url.endsWith("/capability") ? { status: 201, body: cap(++n) } : { status: 503, body: { error: "busy", code: "TRANSFER_BUSY", detail: { retry_after_ms: 5000 } } }));
    await expect(mk(f4.fetchImpl, { maxSendAttempts: 3 }).uploadPart({ operationId: "top-1", partKey: "m0", blob })).rejects.toMatchObject({ code: "TRANSFER_BUSY" });
    expect(n).toBe(3); expect(waits.slice(-2)).toEqual([5000, 5000]);
    // sin retry_after_ms en detail → cabecera Retry-After en segundos
    const f5 = fakeFetch((c) => (c.url.endsWith("/capability") ? { status: 201, body: cap(1) } : { status: 503, body: { error: "x", code: "UPLOAD_FAILED" }, headers: { "retry-after": "3" } }));
    await expect(mk(f5.fetchImpl, { maxSendAttempts: 2 }).uploadPart({ operationId: "top-1", partKey: "m0", blob })).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    expect(waits.at(-1)).toBe(3000);
  });

  it("uploadProject: PUT a la ruta PROJECT con X-Catalog-Filename; commit: 200 → COMMITTED, 202 → observar hasta COMMITTED, VERSION_CONFLICT → CONFLICT con error", async () => {
    const blob = new Blob([new TextEncoder().encode("zip!")], { type: "application/zip" });
    const fp = fakeFetch(() => ({ status: 200, body: op("VERIFYING", { upload: { state: "RECEIPT" } }) }));
    const rp = await mk(fp.fetchImpl).uploadProject({ operationId: "top-1", partKey: "p0", blob, filename: "song.flp" });
    expect(rp.state).toBe("RECEIPT");
    expect(fp.calls[0].url).toBe("https://cloud.invalid/api/catalog/v1/operations/top-1/parts/p0/project");
    expect(fp.calls[0].headers["X-Catalog-Filename"]).toBe("song.flp");
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
