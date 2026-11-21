// E77 — SOLO LABORATORIO (desarrollo): doble del puerto Direct B para el LAB de navegador con Telegram SIMULADO.
// El navegador real no puede hablar MTProto con un Telegram falso, así que en `vite dev` con VITE_CATALOG_LAB_DIRECT el puerto habla HTTP con el
// «Telegram» en memoria que levanta scripts/catalog-lab/lab-preload.cjs (un proceso de pruebas, no el Cloud). Mismo contrato que el puerto real:
// el Cloud sigue sin ver bytes. Nunca entra en un build de producción (la rama que lo carga exige import.meta.env.DEV).
import { DirectSendError, type DirectFailure } from "./catalogDirectCore";
import { DirectUnavailableError, type DirectPort, type DirectReadOptions, type DirectReadRef, type DirectSendRequest } from "./catalogDirectTypes";
import { Sha256 } from "./catalogTransfer";

// POST del envío con los eventos de bytes enviados del propio transporte (XMLHttpRequest.upload): el aviso de subida del LAB avanza con bytes
// reales, igual que con el puerto real (progreso de saveFilePart/saveBigFilePart del Worker MTProto). Sin XHR (pruebas) → fetch sin progreso.
function labPost(target: string, body: Blob, onProgress?: (uploadedBytes: number, totalBytes: number) => void): Promise<Response> {
  if (typeof XMLHttpRequest === "undefined" || !onProgress) return fetch(target, { method: "POST", body });
  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", target); xhr.responseType = "text";
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : body.size);
    xhr.onload = () => resolve(new Response(xhr.responseText, { status: xhr.status, headers: { "Content-Type": xhr.getResponseHeader("Content-Type") ?? "application/json" } }));
    xhr.onerror = () => reject(new TypeError("lab telegram unreachable"));
    xhr.send(body);
  });
}

export function createLabDirectPort(base: string): DirectPort {
  const url = (path: string, q: Record<string, string | number>) => `${base.replace(/\/$/, "")}/lab-telegram/${path}?${new URLSearchParams(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])))}`;
  const port: DirectPort = {
    ready: async () => true,
    close: async () => {},
    async read(ref: DirectReadRef, o: DirectReadOptions = {}) {
      const offset = o.offset ?? 0; const length = o.length ?? ref.size - offset;
      let r: Response;
      try { r = await fetch(url("read", { chatId: ref.chatId, messageId: ref.messageId, offset, length }), { signal: o.signal }); } catch (error) { if (o.signal?.aborted) throw error; throw new DirectUnavailableError("SESSION", "lab telegram unreachable"); }
      if (!r.ok) throw new DirectUnavailableError("SESSION", `lab telegram read ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { blob: new Blob([bytes as BlobPart]), sha256: o.hash === true && offset === 0 && length === ref.size ? new Sha256().update(bytes).digestHex() : null };
    },
    async send(input: DirectSendRequest, o: { signal?: AbortSignal; onProgress?: (uploadedBytes: number, totalBytes: number) => void } = {}) {
      let r: Response;
      try { r = await labPost(url("send", { chatId: input.chatId, randomId: input.randomId, caption: input.caption, filename: input.filename, mime: input.mime }), input.blob, o.onProgress); } catch { throw new DirectSendError({ kind: "UNCERTAIN", code: "LAB_NETWORK", retryAfterMs: 60_000 }); }
      const body = (await r.json().catch(() => ({}))) as { messageId?: number; documentId?: string | null; size?: number; senderId?: string; chatId?: string; failure?: DirectFailure };
      if (!r.ok || !body.messageId) throw new DirectSendError(body.failure ?? { kind: "UNCERTAIN", code: "LAB_NO_RECEIPT", retryAfterMs: 60_000 });
      return { messageId: body.messageId, documentId: body.documentId ?? null, size: Number(body.size), senderId: String(body.senderId), chatId: String(body.chatId) };
    },
  };
  return Object.freeze(port);
}
