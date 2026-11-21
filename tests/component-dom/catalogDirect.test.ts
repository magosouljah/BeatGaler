// @vitest-environment node
// E70 — Direct B (Web): núcleo de envío/clasificación, flujo de transferencia con ticket/informe/recibo, lectura directa con hash sobre los bytes
// recibidos y puerto de sesión. TODO con dobles (sin Telegram real, sin red): no prueba el aislamiento entre usuarios que comparten un bot ni G2.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CatalogApiError } from "../../src/features/library/catalog/catalogApi";
import { DirectSendError, classifyDirectError, runDirectSend } from "../../src/features/library/catalog/catalogDirectCore";
import { DirectUnavailableError, type DirectPort, type DirectReadRef, type DirectSendRequest } from "../../src/features/library/catalog/catalogDirectTypes";
import { createCatalogDirectPort, type DirectRuntime } from "../../src/features/library/catalog/catalogDirectPort";
import { createCatalogMediaClient } from "../../src/features/library/catalog/catalogMediaClient";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const rpc = (text: string, code = 400) => Object.assign(new Error(text), { text, code });

describe("catalogDirectCore: clasificación fail-closed y orden subida → envío", () => {
  it("subida: nunca incierta; envío: solo un error RPC explícito prueba la ausencia de efecto; lo desconocido es UNCERTAIN", () => {
    expect(classifyDirectError(rpc("FLOOD_WAIT_7"), "send")).toMatchObject({ kind: "REJECTED", retryAfterMs: 7000 });
    expect(classifyDirectError(rpc("SLOWMODE_WAIT_3"), "send")).toMatchObject({ kind: "REJECTED", retryAfterMs: 3000 });
    expect(classifyDirectError(rpc("CHAT_WRITE_FORBIDDEN", 403), "send")).toMatchObject({ kind: "PERMANENT" });
    expect(classifyDirectError(rpc("AUTH_KEY_UNREGISTERED", 401), "send")).toMatchObject({ kind: "REVOKED" });
    expect(classifyDirectError(rpc("AUTH_KEY_UNREGISTERED", 401), "upload")).toMatchObject({ kind: "REVOKED" });
    expect(classifyDirectError(new Error("socket closed"), "send")).toMatchObject({ kind: "UNCERTAIN" });
    expect(classifyDirectError(new Error("timeout"), "send")).toMatchObject({ kind: "UNCERTAIN" });
    expect(classifyDirectError(rpc("RANDOM_ID_DUPLICATE"), "send")).toMatchObject({ kind: "UNCERTAIN" });
    expect(classifyDirectError(undefined, "send")).toMatchObject({ kind: "UNCERTAIN" });
    expect(classifyDirectError(new Error("socket closed"), "upload")).toMatchObject({ kind: "UPLOAD_FAILED" });
    expect(classifyDirectError(rpc("FLOOD_WAIT_4"), "upload")).toMatchObject({ kind: "UPLOAD_FAILED", retryAfterMs: 4000 });
  });

  const caption = "catalog:v1 op=top-1 part=m0";
  function deps(over: { upload?: () => Promise<unknown>; send?: (media: unknown, p: { randomId: unknown }) => Promise<unknown> } = {}) {
    const calls: string[] = []; let sentRandom: unknown = null; let sentMedia: Record<string, unknown> | null = null;
    return {
      calls, get sentRandom() { return sentRandom; }, get sentMedia() { return sentMedia; },
      deps: {
        client: {
          uploadFile: async () => { calls.push("upload"); if (over.upload) return over.upload(); return { uploaded: true }; },
          sendMedia: async (_chat: number, media: unknown, p: { randomId: unknown }) => { calls.push("send"); sentRandom = p.randomId; sentMedia = media as Record<string, unknown>; if (over.send) return over.send(media, p); return { id: 4242, media: { fileSize: 3, raw: { id: { toString: () => "777" } } } }; },
        },
        makeMedia: (uploaded: unknown, o: Record<string, unknown>) => ({ uploaded, ...o }),
        toLong: (d: string) => ({ long: d }),
        chatId: -100123,
      },
    };
  }
  const input = (over: Record<string, unknown> = {}) => ({ file: new Blob(["abc"]), filename: "a.mp3", mime: "audio/mpeg", caption, randomId: "-123456789012345", size: 3, ...over });

  it("sube primero, envía con el randomId y el caption del ticket y devuelve el recibo del mensaje", async () => {
    const h = deps();
    const r = await runDirectSend(h.deps as never, input());
    expect(h.calls).toEqual(["upload", "send"]);
    expect(h.sentRandom).toEqual({ long: "-123456789012345" }); expect((h.sentMedia as Record<string, unknown>).caption).toBe(caption);
    expect(r).toEqual({ messageId: 4242, documentId: "777", size: 3 });
  });
  it("entradas inválidas fallan ANTES de cualquier efecto (identidad, tamaño, caption)", async () => {
    for (const bad of [{ randomId: "abc" }, { randomId: "9".repeat(25) }, { size: 4 }, { caption: "hola" }]) {
      const h = deps();
      await expect(runDirectSend(h.deps as never, input(bad))).rejects.toMatchObject({ failure: { kind: "PERMANENT" } });
      expect(h.calls).toEqual([]);
    }
  });
  it("fallo de subida = sin efecto (no se llega a enviar); fallo RPC en el envío = REJECTED; red/timeout/sin id = UNCERTAIN", async () => {
    let h = deps({ upload: async () => { throw new Error("socket closed"); } });
    await expect(runDirectSend(h.deps as never, input())).rejects.toMatchObject({ failure: { kind: "UPLOAD_FAILED" } }); expect(h.calls).toEqual(["upload"]);
    h = deps({ send: async () => { throw rpc("FLOOD_WAIT_2"); } });
    await expect(runDirectSend(h.deps as never, input())).rejects.toMatchObject({ failure: { kind: "REJECTED", retryAfterMs: 2000 } });
    h = deps({ send: async () => { throw new Error("timeout"); } });
    await expect(runDirectSend(h.deps as never, input())).rejects.toBeInstanceOf(DirectSendError);
    await expect(runDirectSend(h.deps as never, input())).rejects.toMatchObject({ failure: { kind: "UNCERTAIN" } });
    h = deps({ send: async () => ({ media: {} }) });
    await expect(runDirectSend(h.deps as never, input())).rejects.toMatchObject({ failure: { kind: "UNCERTAIN", code: "NO_MESSAGE_ID" } });
  });
});

// ---------- transferencia con ticket / informe / recibo ----------
type Call = { url: string; method: string; body: unknown };
const TICKET = (attempt: number, over: Record<string, unknown> = {}) => ({ operationId: "top-1", partKey: "m0", attempt, randomId: "-777", caption: "catalog:v1 op=top-1 part=m0", chatId: "-1001", botId: "Bot20", filename: "a.mp3", mime: "audio/mpeg", size: 3, declaredSha256: null, level: "CLIENT", ...over });
const OP = (status = "VERIFYING") => ({ operationId: "top-1", kind: "IMPORT", status, beatId: "b-1", parts: [], progress: { total: 1, verified: 0, receipts: 1 }, reservation: null, result: null, lastError: null });

function server(handler: (c: Call, n: number) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input).replace("https://cloud.invalid/api", ""), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
    calls.push(c); const r = handler(c, calls.length);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
function fakePort(over: Partial<DirectPort> & { sent?: DirectSendRequest[] } = {}): DirectPort & { sent: DirectSendRequest[] } {
  const sent: DirectSendRequest[] = over.sent ?? [];
  return {
    sent,
    ready: over.ready ?? (async () => true),
    send: over.send ?? (async (i) => { sent.push(i); return { messageId: 5001, documentId: "88", size: i.size, senderId: "20", chatId: i.chatId }; }),
    read: over.read ?? (async () => { throw new DirectUnavailableError("SESSION"); }),
    close: async () => {},
  };
}
const waits: number[] = [];
const mk = (fetchImpl: typeof fetch, direct: DirectPort | null) => createCatalogTransfer({ fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "e1", epoch: "1" }), sleep: async (ms) => { waits.push(ms); }, direct });
const blob = () => new Blob([new TextEncoder().encode("abc")], { type: "audio/mpeg" });
const paths = (calls: Call[]) => calls.map((c) => `${c.method} ${c.url.replace("/catalog/v1/operations/top-1/parts/m0", "")}`);

describe("catalogTransfer Direct B", () => {
  it("camino feliz: ticket → envío con la identidad del servidor → recibo; ni capacidad ni bytes por el gateway", async () => {
    const s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : c.url.endsWith("/direct-receipt") ? { status: 200, body: { ...OP(), upload: { state: "RECEIPT", level: "CLIENT" } } } : { status: 404 }));
    const port = fakePort(); const t = mk(s.fetchImpl, port);
    const r = await t.uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() });
    expect(r.state).toBe("RECEIPT");
    expect(paths(s.calls)).toEqual(["POST /send-ticket", "PUT /direct-receipt"]);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ randomId: "-777", caption: "catalog:v1 op=top-1 part=m0", chatId: "-1001", size: 3, filename: "a.mp3" });
    expect(s.calls[1].body).toEqual({ attempt: 1, receipt: { messageId: 5001, documentId: "88", size: 3, senderId: "20", chatId: "-1001" } });
  });

  it("rechazo sin efecto (flood): informa, espera y pide OTRO ticket con la MISMA identidad; un único envío efectivo", async () => {
    waits.length = 0; let tickets = 0; let sends = 0;
    const s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(++tickets) } : c.url.endsWith("/send-report") ? { status: 200, body: { state: "REJECTED", retry: "SAME_IDENTITY" } } : c.url.endsWith("/direct-receipt") ? { status: 200, body: OP() } : { status: 404 }));
    const port = fakePort({ send: async (i) => { if (++sends === 1) throw new DirectSendError({ kind: "REJECTED", code: "FLOOD_WAIT_3", retryAfterMs: 3000 }); return { messageId: 5002, documentId: null, size: i.size, senderId: "20", chatId: i.chatId }; } });
    const r = await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() });
    expect(r.state).toBe("RECEIPT"); expect(waits).toEqual([3000]);
    expect(paths(s.calls)).toEqual(["POST /send-ticket", "POST /send-report", "POST /send-ticket", "PUT /direct-receipt"]);
    expect(s.calls[1].body).toMatchObject({ attempt: 1, outcome: "REJECTED", code: "FLOOD_WAIT_3", retryAfterMs: 3000 });
    expect(s.calls[3].body).toMatchObject({ attempt: 2 });
  });

  it("incierto (respuesta perdida / error desconocido): informa UNCERTAIN y NO reenvía; se observa la operación", async () => {
    for (const failure of [new DirectSendError({ kind: "UNCERTAIN", code: "ETIMEDOUT", retryAfterMs: 60_000 }), new Error("worker crashed")]) {
      let sends = 0;
      const s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : c.url.endsWith("/send-report") ? { status: 200, body: { state: "UNCERTAIN", reconcile: true, resend: "BLOCKED" } } : c.url.endsWith("/operations/top-1") ? { status: 200, body: OP("RECONCILE") } : { status: 404 }));
      const port = fakePort({ send: async () => { sends++; throw failure; } });
      const r = await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() });
      expect(r.state).toBe("UNCERTAIN"); expect(sends).toBe(1);
      expect(s.calls.filter((c) => c.url.endsWith("/send-ticket"))).toHaveLength(1);
      expect(s.calls.find((c) => c.url.endsWith("/send-report"))!.body).toMatchObject({ outcome: "UNCERTAIN" });
    }
  });

  it("si el informe no llega al servidor, el resultado se trata como incierto (nunca reintenta)", async () => {
    const s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : c.url.endsWith("/send-report") ? new Error("offline") : { status: 200, body: OP("RECONCILE") }));
    const port = fakePort({ send: async () => { throw new DirectSendError({ kind: "REJECTED", code: "FLOOD_WAIT_9", retryAfterMs: 9000 }); } });
    const r = await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() });
    expect(r.state).toBe("UNCERTAIN"); expect(s.calls.filter((c) => c.url.endsWith("/send-ticket"))).toHaveLength(1);
  });

  it("PERMANENT → 403 visible; REVOKED → CREDENTIAL_REVOKED; sin sesión en el envío → sin efecto, mismo mecanismo de reintento", async () => {
    for (const [kind, code, status] of [["PERMANENT", "SEND_REJECTED_PERMANENT", 403], ["REVOKED", "CREDENTIAL_REVOKED", 503]] as const) {
      const s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : { status: 200, body: { state: kind } }));
      const port = fakePort({ send: async () => { throw new DirectSendError({ kind, code: "X", retryAfterMs: 0 }); } });
      await expect(mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).rejects.toMatchObject({ code, status });
    }
    waits.length = 0; let n = 0;
    const s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(++n) } : c.url.endsWith("/send-report") ? { status: 200, body: { state: "UPLOAD_FAILED", retry: "SAME_IDENTITY" } } : { status: 200, body: OP() }));
    let sends = 0; const port = fakePort({ send: async (i) => { if (++sends === 1) throw new DirectUnavailableError("SESSION"); return { messageId: 9, documentId: null, size: i.size, senderId: "20", chatId: i.chatId }; } });
    expect((await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).state).toBe("RECEIPT");
    expect(s.calls.find((c) => c.url.endsWith("/send-report"))!.body).toMatchObject({ outcome: "UPLOAD_FAILED", code: "DIRECT_UNAVAILABLE" });
  });

  it("PART_UNCERTAIN al pedir el ticket → incierto sin enviar; tamaño distinto → informa sin efecto y pide reseleccionar; sesión no lista o sin puerto → DIRECT_UNAVAILABLE sin tocar el Cloud", async () => {
    let s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 409, body: { code: "PART_UNCERTAIN", error: "uncertain" } } : { status: 200, body: OP("RECONCILE") }));
    let port = fakePort();
    expect((await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).state).toBe("UNCERTAIN"); expect(port.sent).toHaveLength(0);
    s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1, { size: 99 }) } : { status: 200, body: {} }));
    port = fakePort();
    await expect(mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).rejects.toMatchObject({ code: "PART_BYTES_MISMATCH" });
    expect(port.sent).toHaveLength(0); expect(s.calls.find((c) => c.url.endsWith("/send-report"))!.body).toMatchObject({ outcome: "UPLOAD_FAILED", code: "BYTES_MISMATCH" });
    // E77: sin sesión directa (o sin puerto) la subida falla ANTES de cualquier efecto y nunca se usa el Cloud para los bytes
    for (const direct of [fakePort({ ready: async () => false }), null]) {
      s = server(() => ({ status: 500, body: {} }));
      await expect(mk(s.fetchImpl, direct).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).rejects.toMatchObject({ status: 503, code: "DIRECT_UNAVAILABLE" });
      expect(s.calls).toHaveLength(0);
    }
  });

  it("recibo: fallos de red reintentados (idempotente) y, si no se logra, incierto; RECEIPT_CONFLICT es visible y no se reenvía", async () => {
    waits.length = 0; let receipts = 0;
    let s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : c.url.endsWith("/direct-receipt") ? (++receipts < 3 ? new Error("offline") : { status: 200, body: OP() }) : { status: 404 }));
    let port = fakePort();
    expect((await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).state).toBe("RECEIPT"); expect(receipts).toBe(3); expect(port.sent).toHaveLength(1);
    s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : c.url.endsWith("/direct-receipt") ? new Error("offline") : { status: 200, body: OP("RECONCILE") }));
    port = fakePort();
    expect((await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).state).toBe("UNCERTAIN"); expect(port.sent).toHaveLength(1);
    s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : c.url.endsWith("/direct-receipt") ? { status: 409, body: { code: "RECEIPT_CONFLICT", error: "x" } } : { status: 404 }));
    port = fakePort();
    await expect(mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).rejects.toBeInstanceOf(CatalogApiError); expect(port.sent).toHaveLength(1);
  });
});

// ---------- lectura directa ----------
const bytes = (() => { const b = new Uint8Array(5000); for (let i = 0; i < b.length; i++) b[i] = (i * 13 + 5) & 0xff; return b; })();
function mediaServer(over: { sha?: string | null; bytesVerified?: boolean } = {}) {
  const s = server((c) => {
    if (c.url.includes("/files/f-1/access")) return { status: 201, body: access() };
    if (c.url.includes("/files/f-1/parts/0/bytes")) return { status: 200, body: { level: "BYTES" } };
    return { status: 404, body: {} };
  });
  function access() {
    const sha256 = over.sha === undefined ? sha(bytes) : over.sha;
    return { fileId: "f-1", beatId: "b-1", role: "MASTER", slotKey: "MASTER", revision: "1", filename: "a.mp3", mime: "audio/mpeg", sizeBytes: bytes.length, partsTotalBytes: bytes.length, sha256, declaredSha256: sha256, cacheKey: "u:1:b-1:f-1:1", epoch: "1", revisionLibrary: "1", ttlMs: 600000,
      parts: [{ partIndex: 0, size: bytes.length, sha256, hashVerified: false, verificationLevel: "PROVIDER", bytesVerified: over.bytesVerified === true, direct: { chatId: "-1001", messageId: 5001 } }] };
  }
  return s;
}
const client = (s: ReturnType<typeof server>, direct: DirectPort | null) => createCatalogMediaClient({ fetchImpl: s.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "e", epoch: "1" }), accountId: () => "acc", direct });
const readerFor = (log: Array<{ ref: DirectReadRef; offset?: number; length?: number; hash?: boolean }>, data = bytes): DirectPort["read"] => async (ref, o = {}) => {
  log.push({ ref, offset: o.offset, length: o.length, hash: o.hash });
  const off = o.offset ?? 0; const len = o.length ?? ref.size - off; const slice = data.subarray(off, off + len);
  return { blob: new Blob([slice]), sha256: o.hash && off === 0 && len === ref.size ? sha(slice) : null };
};

describe("catalogMediaClient Direct B", () => {
  it("descarga directa: verifica el hash sobre los bytes recibidos (una pasada), atestigua BYTES y el Cloud solo recibe metadatos", async () => {
    const s = mediaServer(); const log: Array<{ ref: DirectReadRef; offset?: number; length?: number; hash?: boolean }> = [];
    const c = client(s, fakePort({ read: readerFor(log) }));
    const r = await c.downloadFile("f-1");
    expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(bytes); expect(r.verified).toBe("BYTES");
    expect(log).toEqual([{ ref: { chatId: "-1001", messageId: 5001, size: bytes.length }, offset: 0, length: bytes.length, hash: true }]);
    expect(s.calls.some((x) => x.url.includes("/catalog/v1/media/"))).toBe(false);
    expect(s.calls[0].url.endsWith("/files/f-1/access")).toBe(true); expect(s.calls.every((x) => typeof x.body !== "object" || !(x.body instanceof Blob))).toBe(true);
    await new Promise((r2) => setTimeout(r2, 0));
    expect(s.calls.find((x) => x.url.includes("/parts/0/bytes"))!.body).toEqual({ sha256: sha(bytes), size: bytes.length });
    expect(c.metrics).toMatchObject({ directReads: 1, directBytes: bytes.length, directFailures: 0, bytesConfirmed: 1 });
  });
  it("hash distinto en los bytes recibidos → MEDIA_HASH_MISMATCH sin atestiguar; ya atestiguado → no repite el informe", async () => {
    let s = mediaServer(); const bad = bytes.slice(); bad[10] ^= 0xff;
    await expect(client(s, fakePort({ read: readerFor([], bad) })).downloadFile("f-1")).rejects.toMatchObject({ code: "MEDIA_HASH_MISMATCH" });
    expect(s.calls.some((x) => x.url.includes("/catalog/v1/media/") || x.url.includes("/parts/0/bytes"))).toBe(false);
    s = mediaServer({ bytesVerified: true });
    await client(s, fakePort({ read: readerFor([]) })).downloadFile("f-1"); await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.some((x) => x.url.includes("/parts/0/bytes"))).toBe(false);
  });
  it("sin sesión Direct → DIRECT_UNAVAILABLE; lectura fallida → MEDIA_UNAVAILABLE; sin puerto → DIRECT_UNAVAILABLE. Nunca se piden bytes al Cloud", async () => {
    const cases: Array<[DirectPort | null, string, number]> = [[fakePort({ ready: async () => false }), "DIRECT_UNAVAILABLE", 503], [fakePort({ read: async () => { throw new Error("lost"); } }), "MEDIA_UNAVAILABLE", 502], [null, "DIRECT_UNAVAILABLE", 503]];
    for (const [port, code, status] of cases) {
      const s = server((c) => (c.url.includes("/access") ? { status: 201, body: { fileId: "f-1", beatId: "b-1", role: "MASTER", slotKey: "MASTER", revision: "1", filename: "a", mime: "audio/mpeg", sizeBytes: 3, partsTotalBytes: 3, sha256: null, declaredSha256: null, cacheKey: "k", epoch: "1", revisionLibrary: "1", ttlMs: 600000, parts: [{ partIndex: 0, size: 3, sha256: null, hashVerified: false, verificationLevel: null, direct: { chatId: "-1001", messageId: 5001 } }] } } : { status: 500 }));
      const c = createCatalogMediaClient({ fetchImpl: s.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "e", epoch: "1" }), accountId: () => "acc", direct: port });
      await expect(c.downloadFile("f-1")).rejects.toMatchObject({ code, status });
      expect(s.calls.map((x) => x.url.replace("/catalog/v1/files/f-1", ""))).toEqual(["/access"]); // solo la autorización; ninguna ruta de bytes
    }
  });
  it("fetchPart con rango: lectura directa del rango exacto; un rango no soportado es un error (416)", async () => {
    const s = mediaServer(); const log: Array<{ ref: DirectReadRef; offset?: number; length?: number }> = [];
    const c = client(s, fakePort({ read: readerFor(log) }));
    const a = await c.access("f-1");
    const part = await c.fetchPart(a.parts[0], { range: "bytes=4096-4999" });
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(4096, 5000)); expect(log[0]).toMatchObject({ offset: 4096, length: 904 });
    await expect(c.fetchPart(a.parts[0], { range: "bytes=-5" })).rejects.toMatchObject({ code: "RANGE_NOT_SATISFIABLE" });
  });
});

// ---------- puerto de sesión ----------
function fakeRuntime(over: Partial<DirectRuntime> = {}) {
  const log: string[] = []; const reads: Array<{ offset: number; length: number }> = [];
  const rt = {
    log, reads,
    initialize: async () => { log.push("init"); },
    replaceCredentials: async () => {}, verifyIdentity: async () => {}, verifyReady: async () => {},
    shutdown: async () => { log.push("shutdown"); },
    catalogSend: over.catalogSend ?? (async (i) => ({ messageId: 1, documentId: null, size: i.size, senderId: "20", chatId: "-1001" })),
    catalogRead: over.catalogRead ?? (async (i) => { reads.push({ offset: i.offset, length: i.length }); const end = Math.min(bytes.length, i.offset + i.length); const slice = bytes.slice(i.offset, end); return { buffer: slice.buffer as ArrayBuffer, totalBytes: bytes.length }; }),
    cancelCatalogRead: () => {},
  };
  return rt as unknown as DirectRuntime & { log: string[]; reads: Array<{ offset: number; length: number }> };
}
const fakeSession = { session_id: "s1", generation: 1, credential_version: 1, transport_id: "Bot20", chat_id: "-1001", heartbeat_interval_ms: 600000, temp_auth: { expires_at: Math.floor(Date.now() / 1000) + 600, expected_bot_id: "20", api_id: 1, dc_id: 2, binding: {} }, temp_auth_key: new Uint8Array(256) } as never;
const fakeApi = (over: Record<string, unknown> = {}) => ({ reserve: async () => ({ session_id: "s1" }), bind: async () => fakeSession, activate: async () => ({ activated: true }), heartbeat: async () => ({ expired: false, credentialRefresh: null }), authorize: async () => {}, begin: async () => ({ expired: false, waitMs: null, credentialRefresh: null, operationId: null }), end: async () => {}, stop: async () => {}, ...over }) as never;

describe("catalogDirectPort", () => {
  it("ready abre la sesión una vez y la reutiliza; read alinea a 4 KiB, recorta y calcula el hash de los bytes recibidos; send exige el chat del vault", async () => {
    const rt = fakeRuntime(); const port = createCatalogDirectPort({ enabled: () => true, runtime: () => rt, api: fakeApi(), readyTimeoutMs: 2000 });
    expect(await port.ready()).toBe(true); expect(await port.ready()).toBe(true); expect(rt.log.filter((x) => x === "init")).toHaveLength(1);
    const ref = { chatId: "-1001", messageId: 5001, size: bytes.length };
    const full = await port.read(ref, { hash: true }); expect(full.sha256).toBe(sha(bytes)); expect(new Uint8Array(await full.blob.arrayBuffer())).toEqual(bytes);
    const mid = await port.read(ref, { offset: 4100, length: 500 }); expect(new Uint8Array(await mid.blob.arrayBuffer())).toEqual(bytes.subarray(4100, 4600)); expect(mid.sha256).toBeNull();
    expect(rt.reads.at(-1)).toEqual({ offset: 4096, length: 504 });
    await expect(port.read({ ...ref, chatId: "-999" })).rejects.toBeInstanceOf(DirectUnavailableError);
    await expect(port.send({ blob: new Blob(["abc"]), filename: "a", mime: "x", caption: "catalog:v1 op=a part=b", randomId: "1", chatId: "-999", size: 3 })).rejects.toMatchObject({ failure: { kind: "PERMANENT", code: "CHAT_MISMATCH" } });
    expect((await port.send({ blob: new Blob(["abc"]), filename: "a", mime: "x", caption: "catalog:v1 op=a part=b", randomId: "1", chatId: "-1001", size: 3 })).messageId).toBe(1);
    await port.close(); expect(rt.log).toContain("shutdown"); expect(await port.ready()).toBe(false);
  });
  it("errores del Worker: con clasificación se propaga; sin ella (Worker perdido) es UNCERTAIN; lectura corta es error", async () => {
    const failure = { kind: "REJECTED", code: "FLOOD_WAIT_5", retryAfterMs: 5000 };
    let rt = fakeRuntime({ catalogSend: async () => { throw Object.assign(new Error("send: FLOOD_WAIT_5"), { failure }); } });
    let port = createCatalogDirectPort({ enabled: () => true, runtime: () => rt, api: fakeApi() });
    const req = { blob: new Blob(["abc"]), filename: "a", mime: "x", caption: "catalog:v1 op=a part=b", randomId: "1", chatId: "-1001", size: 3 };
    await expect(port.send(req)).rejects.toMatchObject({ failure });
    rt = fakeRuntime({ catalogSend: async () => { throw new Error("Worker stopped"); } }); port = createCatalogDirectPort({ enabled: () => true, runtime: () => rt, api: fakeApi() });
    await expect(port.send(req)).rejects.toMatchObject({ failure: { kind: "UNCERTAIN", code: "WORKER_LOST" } });
    rt = fakeRuntime({ catalogRead: async () => ({ buffer: new ArrayBuffer(10), totalBytes: bytes.length }) }); port = createCatalogDirectPort({ enabled: () => true, runtime: () => rt, api: fakeApi() });
    await expect(port.read({ chatId: "-1001", messageId: 1, size: bytes.length })).rejects.toBeInstanceOf(DirectUnavailableError);
  });
  it("sesión que falla: ready=false (el llamador usa el gateway) y no se reintenta hasta pasada la espera; deshabilitado → false sin abrir nada", async () => {
    let t = 1000; let binds = 0; const rt = fakeRuntime();
    const port = createCatalogDirectPort({ enabled: () => true, runtime: () => rt, api: fakeApi({ bind: async () => { binds++; throw new Error("bind failed"); } }), retryAfterFailureMs: 60_000, now: () => t });
    expect(await port.ready()).toBe(false); expect(await port.ready()).toBe(false); expect(binds).toBe(1);
    t += 61_000; expect(await port.ready()).toBe(false); expect(binds).toBe(2);
    let built = 0; const off = createCatalogDirectPort({ enabled: () => false, runtime: () => { built++; return fakeRuntime(); }, api: fakeApi() });
    expect(await off.ready()).toBe(false); expect(built).toBe(0);
  });
});

// ---------- E73/E77: espera acotada, apertura compartida y preconexión (sin respaldo por el Cloud) ----------
import { vi } from "vitest";
import { DIRECT_WAIT, createLazyDirectPort } from "../../src/features/library/catalog/catalogDirectTypes";
import { createCatalogServices } from "../../src/features/library/catalog/catalogLibraryProvider";

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("E73/E77 Direct B: espera acotada, preconexión y error claro sin respaldo por Cloud", () => {
  it("puerto: la espera acotada devuelve false sin marcar fallo ni cancelar la apertura; al terminar, la MISMA sesión queda lista (un solo bind)", async () => {
    const gate = deferred<void>(); let binds = 0; const rt = fakeRuntime();
    const port = createCatalogDirectPort({ enabled: () => true, runtime: () => rt, api: fakeApi({ bind: async () => { binds++; await gate.promise; return fakeSession; } }), readyTimeoutMs: 5000 });
    const t0 = Date.now();
    expect(await port.ready(undefined, { maxWaitMs: 30 })).toBe(false); expect(Date.now() - t0).toBeLessThan(1000);
    expect(await port.ready(undefined, { maxWaitMs: 10 })).toBe(false); expect(binds).toBe(1); // sigue la misma apertura, sin enfriamiento
    gate.resolve();
    expect(await port.ready()).toBe(true); expect(await port.ready(undefined, { maxWaitMs: 10 })).toBe(true);
    expect(binds).toBe(1); expect(rt.log.filter((x) => x === "init")).toHaveLength(1);
    await port.close();
  });

  it("fachada diferida: una sola carga/apertura para todos los llamadores; tras una espera vencida las siguientes no vuelven a pagar el plazo", async () => {
    vi.stubGlobal("Worker", function FakeWorker() {}); vi.stubGlobal("WebSocket", function FakeWebSocket() {});
    try {
      const gate = deferred<boolean>(); let loads = 0; let readies = 0;
      const lazy = createLazyDirectPort({ enabled: () => true, load: async () => { loads++; return fakePort({ ready: async () => { readies++; return gate.promise; } }); } });
      const background = lazy.ready(); // preconexión (sin plazo)
      expect(await lazy.ready(undefined, { maxWaitMs: 30 })).toBe(false);
      const t0 = Date.now(); expect(await lazy.ready(undefined, { maxWaitMs: 5000 })).toBe(false); expect(Date.now() - t0).toBeLessThan(500);
      expect(loads).toBe(1); expect(readies).toBe(1);
      gate.resolve(true);
      expect(await background).toBe(true);
      expect(await lazy.ready(undefined, { maxWaitMs: 30 })).toBe(true); expect(loads).toBe(1);
      const ac = new AbortController(); ac.abort();
      await expect(lazy.ready(ac.signal, { maxWaitMs: 30 })).rejects.toMatchObject({ name: "AbortError" });
      await lazy.close();
    } finally { vi.unstubAllGlobals(); }
  });

  it("subida: sesión no lista en el plazo → DIRECT_UNAVAILABLE antes de cualquier efecto (sin ticket, sin envío, sin bytes al Cloud); con la sesión lista, el mismo archivo sube por Direct B", async () => {
    const gate = deferred<boolean>(); const seen: Array<number | undefined> = [];
    const port = fakePort({ ready: async (_s, o) => { seen.push(o?.maxWaitMs); return o?.maxWaitMs == null ? gate.promise : Promise.race([gate.promise, tick(20).then(() => false)]); } });
    const s = server((c) => (c.url.endsWith("/send-ticket") ? { status: 201, body: TICKET(1) } : { status: 200, body: OP() }));
    await expect(mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).rejects.toMatchObject({ status: 503, code: "DIRECT_UNAVAILABLE" });
    expect(seen).toEqual([DIRECT_WAIT.sendMs]); expect(s.calls).toHaveLength(0); expect(port.sent).toHaveLength(0);
    gate.resolve(true); await tick(5);
    expect((await mk(s.fetchImpl, port).uploadPart({ operationId: "top-1", partKey: "m0", blob: blob() })).state).toBe("RECEIPT");
    expect(paths(s.calls)).toEqual(["POST /send-ticket", "PUT /direct-receipt"]); expect(port.sent).toHaveLength(1);
  });

  it("lectura: usa el plazo de lectura; sin sesión lista falla con DIRECT_UNAVAILABLE y no pide bytes al Cloud", async () => {
    const seen: Array<number | undefined> = [];
    const port = fakePort({ ready: async (_s, o) => { seen.push(o?.maxWaitMs); return false; } });
    const s = server((c) => (c.url.includes("/access") ? { status: 201, body: { fileId: "f-1", beatId: "b-1", role: "MASTER", slotKey: "MASTER", revision: "1", filename: "a", mime: "audio/mpeg", sizeBytes: 3, partsTotalBytes: 3, sha256: null, declaredSha256: null, cacheKey: "k", epoch: "1", revisionLibrary: "1", ttlMs: 600000, parts: [{ partIndex: 0, size: 3, sha256: null, hashVerified: false, verificationLevel: null, direct: { chatId: "-1001", messageId: 5001 } }] } } : { status: 500 }));
    const c = createCatalogMediaClient({ fetchImpl: s.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "e", epoch: "1" }), accountId: () => "acc", direct: port });
    await expect(c.downloadFile("f-1")).rejects.toMatchObject({ code: "DIRECT_UNAVAILABLE" });
    expect(seen).toEqual([DIRECT_WAIT.readMs]); expect(s.calls).toHaveLength(1); expect(c.metrics.directReads).toBe(0);
  });

  it("preconexión: al crear los servicios se abre Direct B una vez en segundo plano; teardown antes del plazo la cancela y siempre cierra el puerto", async () => {
    const mkServices = (port: DirectPort, delay: number | null | undefined) => createCatalogServices({ api: {} as never, accountId: "acc", context: { authority_era: "e", authority_epoch: "1" }, fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch, baseUrl: () => "https://cloud.invalid/api", token: () => "t", csrf: () => "c", direct: port, prefixCache: null, prefixSyncDelayMs: null, ...(delay === undefined ? {} : { directPreconnectDelayMs: delay }) });
    let readies = 0; let closed = 0; const args: unknown[] = [];
    const port = (): DirectPort => ({ ...fakePort({ ready: async (_s, o) => { readies++; args.push(o); return true; } }), close: async () => { closed++; } });
    const a = mkServices(port(), 0); await tick(30);
    expect(readies).toBe(1); expect(args[0]).toBeUndefined(); // sin plazo: es la apertura de fondo
    await a.teardown(); expect(closed).toBe(1);
    const b = mkServices(port(), 200); await b.teardown(); await tick(260);
    expect(readies).toBe(1); expect(closed).toBe(2); // cancelada antes de dispararse
    const c = mkServices(port(), undefined); await tick(320); await c.teardown();
    expect(readies).toBe(1); // un doble inyectado no se preconecta salvo que se pida (solo el puerto real lo hace por defecto)
  });
});

// ---------- E77: la renovación de la clave temporal nunca corta una transferencia ----------
import { createCatalogControlApi } from "../../src/features/library/catalog/catalogDirectPort";

describe("E77/E78 Direct B: renovación de clave y transferencias", () => {
  const soon = (seconds: number) => ({ ...(fakeSession as Record<string, unknown>), temp_auth: { ...(fakeSession as { temp_auth: Record<string, unknown> }).temp_auth, expires_at: Math.floor(Date.now() / 1000) + seconds } }) as never;

  it("latido: con un envío pequeño (no reanudable) en curso la renovación se aplaza; sin él y cerca de caducar, se renueva (las transferencias largas la soportan)", async () => {
    let busy = true; let network = 0;
    vi.stubGlobal("fetch", (async () => { network++; throw new Error("offline"); }) as typeof fetch);
    try {
      const api = createCatalogControlApi({ busy: () => busy });
      expect(await api.heartbeat(soon(30))).toEqual({ expired: false, credentialRefresh: null }); expect(network).toBe(0); // aplazada: ni una petición
      expect(await api.heartbeat(soon(500))).toEqual({ expired: false, credentialRefresh: null }); // lejos de caducar: nada que renovar
      busy = false;
      await expect(api.heartbeat(soon(30))).rejects.toBeTruthy(); expect(network).toBeGreaterThan(0); // sin transferencias: intenta renovar (aquí falla por red)
    } finally { vi.unstubAllGlobals(); }
  });

  it("E78 lectura reanudable: un trozo que falla (corte o sustitución del cliente por renovación de clave) se repite y la lectura continúa donde iba", async () => {
    let calls = 0; const offsets: number[] = [];
    const rt = fakeRuntime({ catalogRead: async (i) => { calls++; offsets.push(i.offset); if (calls === 1) throw new Error("Client is closed"); const end = Math.min(bytes.length, i.offset + i.length); return { buffer: bytes.slice(i.offset, end).buffer as ArrayBuffer, totalBytes: bytes.length }; } });
    const port = createCatalogDirectPort({ enabled: () => true, runtime: () => rt, api: fakeApi() });
    const out = await port.read({ chatId: "-1001", messageId: 5001, size: bytes.length }, { hash: true });
    expect(new Uint8Array(await out.blob.arrayBuffer())).toEqual(bytes); expect(out.sha256).toBe(sha(bytes)); expect(offsets).toEqual([0, 0]); // mismo trozo repetido, nada perdido
    // fallo que no se recupera: tras los intentos acotados se informa el error (nunca un resultado parcial)
    const dead = fakeRuntime({ catalogRead: async () => { throw new Error("network down"); } });
    const port2 = createCatalogDirectPort({ enabled: () => true, runtime: () => dead, api: fakeApi() });
    await expect(port2.read({ chatId: "-1001", messageId: 5001, size: bytes.length })).rejects.toThrow("network down");
    await port.close(); await port2.close();
  });
});
