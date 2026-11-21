// @vitest-environment node
// E78 — Subida por partes REANUDABLE entre claves temporales. Dobles: sin Telegram ni Worker. La evidencia de que el proveedor acepta partes
// subidas con claves distintas del mismo bot es REAL (E77, sandbox); aquí se prueba la lógica: progreso conservado, repetición solo de la parte
// en curso, ningún hueco ni duplicado, sin reenvío tras un envío incierto (C7.8) y sin cargar el archivo entero en memoria.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DirectSendError, RESUMABLE_MIN_BYTES, UPLOAD_MAX_PARTS, UPLOAD_PART_BYTES, runDirectSend, uploadResumable, type DirectSendDeps, type ResumableUploadState } from "../../src/features/library/catalog/catalogDirectCore";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytesOf = (n: number, salt = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + salt * 7 + (i >> 9)) & 0xff; return b; };
const rpc = (text: string, code = 400) => Object.assign(new Error(text), { text, code });

/** «Telegram»: guarda la última versión de cada parte por file_id y cuenta cuántas veces se aceptó cada una. */
function provider() {
  const files = new Map<string, Map<number, Uint8Array>>(); const accepted: Array<{ fileId: string; index: number; generation: number }> = [];
  let generation = 1; const faults: Array<(index: number) => Error | null> = [];
  return {
    files, accepted, faults,
    get generation() { return generation; }, renewKey() { generation++; },
    savePart: async ({ fileId, index, bytes }: { fileId: unknown; index: number; totalParts: number; bytes: Uint8Array }) => {
      for (const f of faults) { const e = f(index); if (e) throw e; }
      const key = String(fileId); if (!files.has(key)) files.set(key, new Map()); files.get(key)!.set(index, bytes.slice()); accepted.push({ fileId: key, index, generation });
    },
    assemble(fileId: unknown, totalParts: number) { const parts = files.get(String(fileId))!; const out: Uint8Array[] = []; for (let i = 0; i < totalParts; i++) out.push(parts.get(i)!); const n = out.reduce((x, b) => x + b.length, 0); const all = new Uint8Array(n); let p = 0; for (const b of out) { all.set(b, p); p += b.length; } return all; },
  };
}
let ids = 0; const newFileId = () => `file-${++ids}`;
const deps = (p: ReturnType<typeof provider>, over: Record<string, unknown> = {}) => ({ savePart: p.savePart, waitReady: async () => {}, newFileId, sleep: async () => {}, ...over });

describe("uploadResumable (núcleo)", () => {
  const data = bytesOf(5 * UPLOAD_PART_BYTES + 1000, 3); const file = new Blob([data as BlobPart]);

  it("sube cada parte exactamente una vez, con concurrencia acotada y progreso; el archivo reconstruido es idéntico", async () => {
    const p = provider(); let inflight = 0; let maxInflight = 0; const progress: number[] = [];
    const save = async (a: Parameters<typeof p.savePart>[0]) => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setTimeout(r, 2)); await p.savePart(a); inflight--; };
    const state = await uploadResumable(deps(p, { savePart: save, concurrency: 3 }), file, null, (u) => progress.push(u));
    expect(state.totalParts).toBe(6); expect([...state.done].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(p.accepted.map((x) => x.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]); expect(maxInflight).toBeLessThanOrEqual(3); expect(maxInflight).toBeGreaterThan(1);
    expect(sha(p.assemble(state.fileId, 6))).toBe(sha(data)); expect(progress.at(-1)).toBe(data.length); expect(progress[0]).toBe(0);
  });

  it("renovación de clave a mitad: la parte en curso falla, se espera al cliente nuevo y se repite SOLO esa parte; misma identidad de archivo", async () => {
    const p = provider(); let waits = 0; let failed = false;
    p.faults.push((index) => { if (index === 2 && !failed) { failed = true; p.renewKey(); return new Error("Client is closed"); } return null; }); // el cliente antiguo se destruye durante la parte 2
    const state = await uploadResumable(deps(p, { waitReady: async () => { waits++; }, concurrency: 1 }), file, null);
    expect(waits).toBe(1); expect(p.accepted.map((x) => `${x.index}@${x.generation}`)).toEqual(["0@1", "1@1", "2@2", "3@2", "4@2", "5@2"]); // nada se repite salvo la parte interrumpida
    expect(new Set(p.accepted.map((x) => x.fileId)).size).toBe(1); expect(sha(p.assemble(state.fileId, 6))).toBe(sha(data));
  });

  it("fallo persistente: se rechaza SIN perder el progreso; el siguiente intento continúa donde iba (no empieza de cero)", async () => {
    const p = provider(); const store: { s: ResumableUploadState | null } = { s: null };
    p.faults.push((index) => (index === 3 ? new Error("network down") : null));
    const first = { fileId: newFileId(), size: file.size, partBytes: UPLOAD_PART_BYTES, totalParts: 6, done: new Set<number>() }; store.s = first;
    await expect(uploadResumable(deps(p, { concurrency: 1, maxAttemptsPerPart: 2 }), file, first)).rejects.toThrow("network down");
    expect([...store.s!.done]).toEqual([0, 1, 2]); // confirmado y conservado
    p.faults.length = 0; const before = p.accepted.length;
    const done = await uploadResumable(deps(p, { concurrency: 1 }), file, store.s);
    expect(done.fileId).toBe(first.fileId); expect(p.accepted.slice(before).map((x) => x.index)).toEqual([3, 4, 5]); // solo lo que faltaba
    expect(sha(p.assemble(done.fileId, 6))).toBe(sha(data));
    // otro archivo (otro tamaño) nunca reutiliza el progreso anterior
    const other = new Blob([bytesOf(2 * UPLOAD_PART_BYTES, 9) as BlobPart]); const fresh = await uploadResumable(deps(p), other, done);
    expect(fresh.fileId).not.toBe(first.fileId); expect(fresh.totalParts).toBe(2);
  });

  it("rechazo permanente → se detiene sin reintentar; si el cliente no vuelve, falla sin efecto; archivo por encima del límite de partes → PERMANENT antes de leer nada", async () => {
    let p = provider(); let calls = 0;
    await expect(uploadResumable(deps(p, { savePart: async () => { calls++; throw rpc("CHAT_WRITE_FORBIDDEN", 403); }, concurrency: 1 }), file, null)).rejects.toMatchObject({ text: "CHAT_WRITE_FORBIDDEN" });
    expect(calls).toBe(1);
    p = provider(); p.faults.push(() => new Error("Client is closed"));
    await expect(uploadResumable(deps(p, { waitReady: async () => { throw new Error("transport not ready"); }, concurrency: 1 }), file, null)).rejects.toThrow("transport not ready");
    expect(p.accepted).toHaveLength(0);
    const huge = { size: UPLOAD_MAX_PARTS * UPLOAD_PART_BYTES + 1, slice: () => { throw new Error("no debe leerse"); } } as unknown as Blob;
    await expect(uploadResumable(deps(provider()), huge, null)).rejects.toMatchObject({ failure: { kind: "PERMANENT", code: "FILE_TOO_LARGE" } });
  });
});

describe("runDirectSend con subida reanudable", () => {
  const big = bytesOf(RESUMABLE_MIN_BYTES + 700_000, 5); const bigFile = new Blob([big as BlobPart]);
  const input = (file: Blob) => ({ file, filename: "proyecto.zip", mime: "application/zip", caption: "catalog:v1 op=top-1 part=PROJECT:0", randomId: "-4242", size: file.size });
  function harness(p: ReturnType<typeof provider>, over: { sendMedia?: DirectSendDeps["client"]["sendMedia"] } = {}) {
    const store = new Map<string, ResumableUploadState>(); const log = { uploadFile: 0, sent: [] as unknown[], waits: 0, saves: [] as Array<string | null> };
    const d: DirectSendDeps = {
      client: { uploadFile: async () => { log.uploadFile++; return { simple: true }; }, sendMedia: over.sendMedia ?? (async (_chat, media) => { log.sent.push(media); return { id: 9001, media: { fileSize: (media as { size: number }).size } }; }) },
      makeMedia: (uploaded, o) => ({ uploaded, size: o.fileSize, caption: o.caption }), toLong: (x) => x, chatId: -1001,
      resumable: { savePart: p.savePart, waitReady: async () => { log.waits++; }, newFileId, sleep: async () => {}, concurrency: 4,
        load: (id) => store.get(id) ?? null, save: (id, s) => { log.saves.push(s ? "state" : null); if (s) store.set(id, s); else store.delete(id); }, makeInputFile: (s, name) => ({ big: true, id: s.fileId, parts: s.totalParts, name }) },
    };
    return { d, store, log };
  }

  it("archivo grande: partes reanudables (nunca uploadFile), envío con el InputFile de las partes y el random_id del ticket; el progreso se guarda antes de subir y se limpia al enviar", async () => {
    const p = provider(); const h = harness(p);
    const r = await runDirectSend(h.d, input(bigFile));
    expect(r.messageId).toBe(9001); expect(h.log.uploadFile).toBe(0);
    const media = h.log.sent[0] as { uploaded: { big: boolean; id: string; parts: number; name: string }; caption: string };
    expect(media.uploaded).toMatchObject({ big: true, parts: Math.ceil(big.length / UPLOAD_PART_BYTES), name: "proyecto.zip" }); expect(media.caption).toBe("catalog:v1 op=top-1 part=PROJECT:0");
    expect(sha(p.assemble(media.uploaded.id, media.uploaded.parts))).toBe(sha(big)); expect(h.log.saves[0]).toBe("state"); expect(h.log.saves.at(-1)).toBeNull(); expect(h.store.size).toBe(0);
    // archivo pequeño: subida simple de siempre
    const small = harness(provider()); await runDirectSend(small.d, input(new Blob([bytesOf(3000) as BlobPart]))); expect(small.log.uploadFile).toBe(1);
  });

  it("subida interrumpida → fallo SIN efecto con el progreso guardado; el reintento con la MISMA identidad sube solo lo que falta y envía una sola vez", async () => {
    const p = provider(); const h = harness(p); let block = true;
    p.faults.push((index) => (block && index >= 12 ? new Error("network down") : null));
    await expect(runDirectSend({ ...h.d, resumable: { ...h.d.resumable!, maxAttemptsPerPart: 1 } }, input(bigFile))).rejects.toMatchObject({ failure: { kind: "UPLOAD_FAILED" } });
    expect(h.log.sent).toHaveLength(0); const kept = h.store.get("-4242")!; expect(kept.done.size).toBeGreaterThanOrEqual(12);
    block = false; const before = p.accepted.length; const doneBefore = new Set(kept.done);
    const r = await runDirectSend(h.d, input(bigFile)); expect(r.messageId).toBe(9001); expect(h.log.sent).toHaveLength(1);
    expect(p.accepted.slice(before).every((x) => !doneBefore.has(x.index))).toBe(true); // ninguna parte ya confirmada se volvió a subir
    expect(sha(p.assemble(kept.fileId, kept.totalParts))).toBe(sha(big));
  });

  it("envío final incierto (respuesta perdida) → UNCERTAIN y NO se reenvía (C7.8); un rechazo explícito del envío es sin efecto", async () => {
    const p = provider(); let sends = 0;
    const lost = harness(p, { sendMedia: async () => { sends++; throw new Error("TIMEOUT"); } });
    await expect(runDirectSend(lost.d, input(bigFile))).rejects.toMatchObject({ failure: { kind: "UNCERTAIN" } }); expect(sends).toBe(1);
    const flood = harness(provider(), { sendMedia: async () => { throw rpc("FLOOD_WAIT_7", 420); } });
    const e = await runDirectSend(flood.d, input(bigFile)).catch((x) => x); expect(e).toBeInstanceOf(DirectSendError); expect(e.failure).toMatchObject({ kind: "REJECTED" });
  });
});
