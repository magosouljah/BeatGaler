'use strict';
// T02 — Transporte Telegram fake + reloj controlable (TAREAS T02 §5, V01-B §5).
// Cada frontera puede pausarse, perder la respuesta tras aplicar el efecto, devolver permisos/ausencia,
// duplicar recibos, matar el worker o retrasarse con el reloj fake. Cuenta llamadas, efectos y fallos.
// 'metadata' es una frontera prohibida por defecto: el catálogo no debe pedir metadata al transporte.
// Sin red: todo vive en memoria.

const BOUNDARIES = Object.freeze(['uploadPart', 'verifyMessage', 'publishIndex', 'pinMessage', 'getPinned', 'download', 'deleteMessages', 'deleteTopic', 'metadata']);

class FakeTransportError extends Error {
  constructor(code, boundary, status) { super(`${code} at ${boundary}`); this.code = code; this.boundary = boundary; this.status = status; }
}

function createFakeClock(start = 1762560000000) {
  let now = start; let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    sleep(ms) { return new Promise((r) => this.setTimeout(r, ms)); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
        await Promise.resolve();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function createFakeTransport({ clock = createFakeClock(), allowMetadata = false, handlers = {} } = {}) {
  const counters = Object.fromEntries(BOUNDARIES.map((b) => [b, { calls: 0, effects: 0, faults: 0, inflight: 0 }]));
  const scripts = Object.fromEntries(BOUNDARIES.map((b) => [b, []]));
  const messages = new Map(); // messageId -> { chatId, bytes, pinned, deleted }
  const receipts = [];
  const gates = [];
  let nextMessageId = 1000;
  let killed = false;
  let lastReceipt = null;

  const defaults = {
    uploadPart: ({ chatId, bytes }) => { const id = nextMessageId++; messages.set(id, { chatId, bytes: Number(bytes) || 0, pinned: false, deleted: false }); return { messageId: id, locator: `direct:${id}` }; },
    verifyMessage: ({ messageId }) => { const m = messages.get(messageId); if (!m || m.deleted) throw new FakeTransportError('FAKE_NOT_FOUND', 'verifyMessage', 404); return { messageId, bytes: m.bytes }; },
    publishIndex: ({ chatId, bytes }) => defaults.uploadPart({ chatId, bytes }),
    pinMessage: ({ messageId }) => { const m = messages.get(messageId); if (!m || m.deleted) throw new FakeTransportError('FAKE_NOT_FOUND', 'pinMessage', 404); for (const x of messages.values()) if (x.chatId === m.chatId) x.pinned = false; m.pinned = true; return { messageId }; },
    getPinned: ({ chatId }) => { for (const [id, m] of messages) if (m.chatId === chatId && m.pinned && !m.deleted) return { messageId: id }; return { messageId: null }; },
    download: ({ messageId }) => { const m = messages.get(messageId); if (!m || m.deleted) throw new FakeTransportError('FAKE_NOT_FOUND', 'download', 404); return { messageId, bytes: m.bytes }; },
    deleteMessages: ({ messageIds }) => { let n = 0; for (const id of messageIds || []) { const m = messages.get(id); if (m && !m.deleted) { m.deleted = true; n++; } } return { deleted: n }; },
    deleteTopic: ({ topicId }) => ({ topicId, deleted: true }),
    metadata: () => ({ ok: true }),
  };

  function script(boundary, ...faults) {
    if (!BOUNDARIES.includes(boundary)) throw new Error(`frontera desconocida ${boundary}`);
    scripts[boundary].push(...faults);
  }

  async function invoke(boundary, payload = {}) {
    if (!BOUNDARIES.includes(boundary)) throw new Error(`frontera desconocida ${boundary}`);
    const c = counters[boundary];
    c.calls++;
    if (boundary === 'metadata' && !allowMetadata) { c.faults++; throw new FakeTransportError('FAKE_METADATA_FORBIDDEN', boundary, 500); }
    if (killed) { c.faults++; throw new FakeTransportError('FAKE_WORKER_KILLED', boundary, 0); }
    const fault = scripts[boundary].shift();
    c.inflight++;
    try {
      if (fault) {
        if (fault.type === 'delay') await clock.sleep(fault.ms);
        if (fault.type === 'pause') {
          let release; const p = new Promise((r) => { release = r; });
          gates.push({ boundary, release }); await p;
        }
        if (fault.type === 'permission') { c.faults++; throw new FakeTransportError('FAKE_PERMISSION_DENIED', boundary, 403); }
        if (fault.type === 'absent') { c.faults++; throw new FakeTransportError('FAKE_NOT_FOUND', boundary, 404); }
        if (fault.type === 'kill') { killed = true; c.faults++; throw new FakeTransportError('FAKE_WORKER_KILLED', boundary, 0); }
        if (fault.type === 'duplicateReceipt' && lastReceipt) { c.faults++; receipts.push(lastReceipt); return { ...lastReceipt.result, duplicate: true }; }
      }
      const result = await (handlers[boundary] || defaults[boundary])(payload, { messages });
      c.effects++;
      lastReceipt = { boundary, result, at: clock.now() };
      receipts.push(lastReceipt);
      if (fault && fault.type === 'loseResponse') { c.faults++; throw new FakeTransportError('FAKE_RESPONSE_LOST', boundary, 0); }
      return result;
    } finally { c.inflight--; }
  }

  const api = Object.fromEntries(BOUNDARIES.map((b) => [b, (payload) => invoke(b, payload)]));
  return Object.freeze({
    ...api,
    invoke, script, clock,
    releaseNext(boundary) { const i = gates.findIndex((g) => !boundary || g.boundary === boundary); if (i < 0) return false; gates.splice(i, 1)[0].release(); return true; },
    pausedCount: () => gates.length,
    restart() { killed = false; },
    isKilled: () => killed,
    counters: () => JSON.parse(JSON.stringify(counters)),
    receipts: () => receipts.slice(),
    messages: () => new Map([...messages].map(([k, v]) => [k, { ...v }])),
  });
}

module.exports = { BOUNDARIES, FakeTransportError, createFakeClock, createFakeTransport };
