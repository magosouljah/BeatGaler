// T13 — Servidor fake de comandos /catalog/v1 a nivel fetch (C(T13), V07-A): PATCH con versiones e idempotencia, trash/restore por lote
// (conflicto = nada aplicado), conjuntos (BUILDING → READY tras N consultas), selección server-side (flags, CAS, CONFLICT por revisión,
// FROZEN por operación), operaciones bulk/rename con lotes ≤50 y conflicto programable, transferencias (capacidad → PUT → commit 202/200)
// y detalle SQL. Cuenta llamadas por ruta y expone espías legacy (get_index/replace_index) que deben quedar en 0.
export interface FakeBeat { id: string; version: number; name: string; bpm: string; key: string; tags: string[]; rating: number; color: string | null; color2: string | null; state: "ACTIVE" | "TRASH"; rank: number }
export interface FakeCommandsOptions { beats?: FakeBeat[]; setReadyAfterPolls?: number; bulkBatch?: number; conflictAtBatch?: number | null; quotaMax?: number | null; transferVerifyAfterPolls?: number }
type Json = Record<string, unknown>;

export function fakeBeats(n: number): FakeBeat[] {
  return Array.from({ length: n }, (_, i) => ({ id: `g${i}`, version: 1, name: `Beat ${i}`, bpm: String(100 + (i % 80)), key: ["Cm", "F#m", "Ab", "D"][i % 4], tags: [i % 2 ? "odd" : "even", `t${i % 10}`], rating: i % 6, color: null, color2: null, state: "ACTIVE", rank: i * 1000 }));
}

export function createCatalogFakeCommands(options: FakeCommandsOptions = {}) {
  const beats = new Map((options.beats ?? fakeBeats(120)).map((b) => [b.id, { ...b, tags: [...b.tags] }]));
  let revision = 10; const epoch = "1"; const era = "era-fake";
  const counters: Record<string, number> = {};
  const count = (k: string) => { counters[k] = (counters[k] || 0) + 1; };
  const legacy = { getLibraryIndex: 0, replaceLibraryIndex: 0 };
  const idem = new Map<string, Json>();
  const sets = new Map<string, { setId: string; status: string; memberIds: string[]; polls: number; baseRevision: string; sort: string }>();
  const selections = new Map<string, { selectionId: string; setId: string; sort: string; defaultSelected: boolean; selectionVersion: number; status: string; baseRevision: string; ops: Array<Json>; count: number }>();
  const operations = new Map<string, Json & { kind: string; memberIds: string[]; cursor: number; patch?: Json; rename?: { from: string; to: string }; selectionId?: string }>();
  const transfers = new Map<string, Json & { parts: Array<Json>; polls: number; kind: string; beatId: string }>();
  const capabilities = new Map<string, { operationId: string; partKey: string; used: boolean }>();
  let nextId = 1; let fail: { code: string; status: number; route: RegExp } | null = null;
  const dto = (b: FakeBeat) => ({ id: b.id, version: String(b.version), state: b.state, name: b.name, bpm: b.bpm, key: b.key, tags: [...b.tags], rating: b.rating, color: b.color, color2: b.color2, artwork: null, playback: { fileId: `f-${b.id}`, revision: String(revision) }, hasArtwork: false, hasWav: false, hasStems: false, hasProject: false, fileCount: 1 });
  const err = (status: number, code: string, message: string, detail: Json = {}) => ({ status, body: { error: message, code, detail } });
  const ok = (body: unknown, status = 200) => ({ status, body });
  const bump = () => { revision++; };
  const matches = (q: Json) => [...beats.values()].filter((b) => b.state === ((q.state as string) ?? "ACTIVE") && (!q.q || b.name.toLowerCase().includes(String(q.q).toLowerCase())) && (!(q.includeTags as string[])?.length || (q.includeTags as string[]).some((t) => b.tags.includes(t))) && !((q.excludeTags as string[]) ?? []).some((t) => b.tags.includes(t))).sort((a, b) => a.rank - b.rank).map((b) => b.id);
  const selected = (s: NonNullable<ReturnType<typeof selections.get>>, set: NonNullable<ReturnType<typeof sets.get>>, id: string): boolean => {
    let on = s.defaultSelected;
    for (const op of s.ops) {
      if (op.kind === "CLEAR") on = false;
      else if ((op.kind === "INCLUDE_IDS" || op.kind === "EXCLUDE_IDS") && (op.beatIds as string[]).includes(id)) on = op.kind === "INCLUDE_IDS";
      else if (op.kind === "INCLUDE_RANGE" || op.kind === "EXCLUDE_RANGE") { const a = set.memberIds.indexOf(op.fromBeatId as string); const b = set.memberIds.indexOf(op.toBeatId as string); const i = set.memberIds.indexOf(id); if (a >= 0 && b >= 0 && i >= Math.min(a, b) && i <= Math.max(a, b)) on = op.kind === "INCLUDE_RANGE"; }
    }
    return on;
  };
  const recount = (s: NonNullable<ReturnType<typeof selections.get>>) => { const set = sets.get(s.setId)!; s.count = set.memberIds.filter((id) => selected(s, set, id)).length; };
  const selDto = (s: NonNullable<ReturnType<typeof selections.get>>, flagIds: string[] = []) => { const set = sets.get(s.setId)!; return { selectionId: s.selectionId, setId: s.setId, sort: s.sort, defaultSelected: s.defaultSelected, selectionVersion: String(s.selectionVersion), status: s.status, count: s.count, baseRevision: s.baseRevision, currentRevision: String(revision), stale: s.baseRevision !== String(revision), flags: Object.fromEntries(flagIds.map((id) => [id, set.memberIds.includes(id) && selected(s, set, id)])) }; };
  const opDto = (o: NonNullable<ReturnType<typeof operations.get>>) => ({ operationId: o.operationId, kind: o.kind, status: o.status, setId: o.setId ?? null, selectionId: o.selectionId ?? null, selectionVersion: o.selectionVersion ?? null, expectedRevision: o.expectedRevision ?? null, committedRevision: o.committedRevision ?? null, progress: { total: o.memberIds.length, confirmed: o.confirmed, notExecuted: o.notExecuted, cancelled: o.cancelled, conflictBatchSeq: o.conflictBatchSeq ?? null }, createdAt: "t", updatedAt: "t", completedAt: null });
  const stepOp = (o: NonNullable<ReturnType<typeof operations.get>>) => {
    if (o.status === "QUEUED") o.status = "RUNNING";
    if (o.status !== "RUNNING" && o.status !== "CANCELLING") return;
    if (o.status === "CANCELLING") { o.cancelled = o.memberIds.length - (o.confirmed as number); o.status = "CANCELLED"; return; }
    const batchSize = options.bulkBatch ?? 50; const batchIndex = Math.floor((o.cursor as number) / batchSize) + 1;
    if (options.conflictAtBatch != null && batchIndex === options.conflictAtBatch) { o.status = "CONFLICT"; o.conflictBatchSeq = batchIndex; o.notExecuted = o.memberIds.length - (o.confirmed as number); return; }
    if (o.expectedRevision !== String(revision)) { o.status = "CONFLICT"; o.conflictBatchSeq = batchIndex; o.notExecuted = o.memberIds.length - (o.confirmed as number); return; }
    const batch = o.memberIds.slice(o.cursor as number, (o.cursor as number) + batchSize);
    for (const id of batch) { const b = beats.get(id)!; if (o.kind === "BULK_PATCH") Object.assign(b, o.patch); if (o.kind === "BULK_TRASH") b.state = "TRASH"; if (o.kind === "BULK_RESTORE") b.state = "ACTIVE"; if (o.kind === "TAG_RENAME") { const seen = new Set<string>(); b.tags = b.tags.map((t) => (t.trim().toLowerCase() === o.rename!.from ? o.rename!.to : t)).filter((t) => (seen.has(t) ? false : (seen.add(t), true))); } b.version++; }
    o.cursor = (o.cursor as number) + batch.length; o.confirmed = (o.confirmed as number) + batch.length; bump(); o.expectedRevision = String(revision); o.committedRevision = String(revision);
    if ((o.cursor as number) >= o.memberIds.length) o.status = "COMPLETED";
  };
  const transferDto = (t: NonNullable<ReturnType<typeof transfers.get>>, extra: Json = {}) => ({ operationId: t.operationId, kind: t.kind, status: t.status, beatId: t.beatId, parts: t.parts.map((p) => ({ partKey: p.partKey, slotKey: p.slotKey, role: p.role, partIndex: p.partIndex, dispatchState: p.dispatchState, verified: p.dispatchState === "VERIFIED", attempts: p.attempts })), progress: { total: t.parts.length, verified: t.parts.filter((p) => p.dispatchState === "VERIFIED").length, receipts: t.parts.filter((p) => p.dispatchState === "RECEIPT").length }, reservation: null, result: t.result ?? null, lastError: null, ...extra });

  async function handle(method: string, url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const u = new URL(url); const path = u.pathname.replace(/^.*?\/catalog\/v1/, "/catalog/v1");
    count(`${method} ${path.replace(/\/(top-|op-|sel-|set-)[^/]+/g, "/:id").replace(/\/transfer\/upload\/[^/]+/, "/transfer/upload/:token").replace(/\/beats\/g\d+/, "/beats/:id").replace(/\/parts\/[^/]+/, "/parts/:partKey")}`);
    if (fail && fail.route.test(path)) return err(fail.status, fail.code, `fake ${fail.code}`);
    const j = (body ?? {}) as Json; const key = headers["Idempotency-Key"];
    if (method !== "GET" && (!headers["X-Catalog-Era"] || !headers["X-Catalog-Epoch"])) return err(428, "PRECONDITION_REQUIRED", "era/epoch");
    let m: RegExpExecArray | null;
    if ((m = /^\/catalog\/v1\/beats\/([^/]+)$/.exec(path)) && method === "GET") { const b = beats.get(decodeURIComponent(m[1])); return b ? ok({ ...dto(b), manualRank: String(b.rank), trash: null, updatedAt: "t", etag: `W/"${b.id.length}-${b.version}"`, authorityEra: era, epoch, revision: String(revision), generationId: "g" }) : err(404, "NOT_FOUND", "no beat"); }
    if ((m = /^\/catalog\/v1\/beats\/([^/]+)$/.exec(path)) && method === "PATCH") {
      const b = beats.get(decodeURIComponent(m[1])); if (!b) return err(404, "NOT_FOUND", "no beat");
      const idk = `patch:${key}`; if (key && idem.has(idk)) return ok({ ...idem.get(idk)!, replay: true });
      if (String(j.expectedVersion) !== String(b.version)) return err(409, "VERSION_CONFLICT", "version", { current_version: String(b.version), expected_version: String(j.expectedVersion) });
      Object.assign(b, j.patch as Json); b.version++; bump();
      const r = { noop: false, beat: dto(b), revision: String(revision), operationId: `op-${nextId++}`, replay: false }; if (key) idem.set(idk, r); return ok(r);
    }
    if ((m = /^\/catalog\/v1\/beats\/(trash|restore)$/.exec(path)) && method === "POST") {
      const items = (j.items as Array<{ beatId: string; expectedVersion: string }>) ?? []; if (items.length > 50) return err(413, "PAYLOAD_TOO_LARGE", "batch");
      const idk = `${m[1]}:${key}`; if (key && idem.has(idk)) return ok({ ...idem.get(idk)!, replay: true });
      const conflicts = items.filter((it) => { const b = beats.get(it.beatId); return !b || String(b.version) !== String(it.expectedVersion) || b.state !== (m![1] === "trash" ? "ACTIVE" : "TRASH"); }).map((it) => ({ beatId: it.beatId, reason: "VERSION_CONFLICT" }));
      if (conflicts.length) return err(409, "VERSION_CONFLICT", "batch rejected: no item was applied", { conflicts });
      for (const it of items) { const b = beats.get(it.beatId)!; b.state = m[1] === "trash" ? "TRASH" : "ACTIVE"; b.version++; }
      bump(); const r = { items: items.map((it) => ({ beatId: it.beatId, version: String(beats.get(it.beatId)!.version) })), revision: String(revision), operationId: `op-${nextId++}`, replay: false }; if (key) idem.set(idk, r); return ok(r);
    }
    if (path === "/catalog/v1/query-sets" && method === "POST") { const setId = `set-${nextId++}`; const q = (j.query as Json) ?? {}; sets.set(setId, { setId, status: (options.setReadyAfterPolls ?? 0) > 0 ? "BUILDING" : "READY", memberIds: matches(q), polls: 0, baseRevision: String(revision), sort: String(q.sort ?? "rating") }); const s = sets.get(setId)!; return ok({ setId, status: s.status, scope: "ACTIVE", baseRevision: s.baseRevision, memberCount: s.status === "READY" ? s.memberIds.length : 0, checkpointSeq: 0, predicateHash: "h", errorCode: null, created: true }, 201); }
    if ((m = /^\/catalog\/v1\/query-sets\/([^/]+)$/.exec(path)) && method === "GET") { const s = sets.get(m[1]); if (!s) return err(404, "NOT_FOUND", "set"); s.polls++; if (s.status === "BUILDING" && s.polls >= (options.setReadyAfterPolls ?? 0)) s.status = s.baseRevision === String(revision) ? "READY" : "STALE"; return ok({ setId: s.setId, status: s.status, scope: "ACTIVE", baseRevision: s.baseRevision, memberCount: s.status === "READY" ? s.memberIds.length : 0, checkpointSeq: 0, predicateHash: "h", errorCode: null }); }
    if (path === "/catalog/v1/selections" && method === "POST") { const set = sets.get(String(j.setId)); if (!set || set.status !== "READY" || set.baseRevision !== String(revision)) return err(409, "CURSOR_STALE", "set not READY at this revision"); const selectionId = `sel-${nextId++}`; const s = { selectionId, setId: set.setId, sort: String(j.sort), defaultSelected: Boolean(j.defaultSelected), selectionVersion: 1, status: "ACTIVE", baseRevision: String(revision), ops: [] as Json[], count: 0 }; recount(s); selections.set(selectionId, s); return ok({ ...selDto(s), created: true }, 201); }
    if ((m = /^\/catalog\/v1\/selections\/([^/]+)$/.exec(path)) && method === "GET") { const s = selections.get(m[1]); if (!s) return err(404, "NOT_FOUND", "sel"); return ok(selDto(s, u.searchParams.getAll("beatId"))); }
    if ((m = /^\/catalog\/v1\/selections\/([^/]+)\/ops$/.exec(path)) && method === "POST") {
      const s = selections.get(m[1]); if (!s) return err(404, "NOT_FOUND", "sel");
      if (s.status !== "ACTIVE") return err(409, "SELECTION_CONFLICT", `selection is ${s.status}`, { status: s.status });
      if (s.baseRevision !== String(revision)) { s.status = "CONFLICT"; return err(409, "SELECTION_CONFLICT", "library revision changed", { base_revision: s.baseRevision, current_revision: String(revision) }); }
      if (String(j.selectionVersion) !== String(s.selectionVersion)) return err(409, "SELECTION_CONFLICT", "CAS", { current_version: String(s.selectionVersion) });
      const op = j.op as Json; if ((op.kind === "INCLUDE_IDS" || op.kind === "EXCLUDE_IDS") && (op.beatIds as string[]).length > 50) return err(413, "PAYLOAD_TOO_LARGE", "ids");
      s.ops.push(op); s.selectionVersion++; recount(s); return ok(selDto(s));
    }
    if ((m = /^\/catalog\/v1\/selections\/([^/]+)\/release$/.exec(path)) && method === "POST") { const s = selections.get(m[1]); if (!s) return err(404, "NOT_FOUND", "sel"); if (s.status === "FROZEN") return err(409, "SELECTION_CONFLICT", "frozen"); s.status = "RELEASED"; return ok(selDto(s)); }
    if (path === "/catalog/v1/operations" && method === "POST") {
      if (["IMPORT", "REPLACE"].includes(String(j.kind))) {
        const idk = `transfer:${key}`; if (key && idem.has(idk)) return ok({ ...idem.get(idk)!, replay: true });
        if (options.quotaMax != null && [...beats.values()].length + transfers.size >= options.quotaMax) return err(409, "QUOTA_EXCEEDED", "quota", { used: beats.size, max: options.quotaMax });
        if (j.kind === "REPLACE") { const b = beats.get(String(j.beatId)); if (!b) return err(404, "NOT_FOUND", "beat"); if (String(b.version) !== String(j.expectedVersion)) return err(409, "VERSION_CONFLICT", "version", { current_version: String(b.version), expected_version: String(j.expectedVersion) }); }
        const operationId = `top-${nextId++}`; const beatId = j.kind === "IMPORT" ? `b-${nextId++}` : String(j.beatId);
        const t = { operationId, kind: String(j.kind), status: "PREPARED", beatId, polls: 0, intent: j, parts: ((j.parts as Json[]) ?? []).map((p) => ({ ...p, dispatchState: "PENDING", attempts: 0 })) };
        transfers.set(operationId, t); const r = transferDto(t, { created: true }); if (key) idem.set(idk, r); return ok(r, 201);
      }
      if (j.kind === "PURGE") return err(501, "NOT_IMPLEMENTED", "PURGE operations are delivered by T15");
      const s = selections.get(String(j.selectionId)); if (!s) return err(404, "NOT_FOUND", "sel");
      if (s.status !== "ACTIVE" || String(j.selectionVersion) !== String(s.selectionVersion)) return err(409, "SELECTION_CONFLICT", "selection is not ACTIVE at that version", { status: s.status, current_version: String(s.selectionVersion) });
      if (s.baseRevision !== String(revision)) { s.status = "CONFLICT"; return err(409, "SELECTION_CONFLICT", "library revision changed", { base_revision: s.baseRevision, current_revision: String(revision) }); }
      if (j.kind === "BULK_PATCH" && j.patch && "tags" in (j.patch as Json)) return err(400, "INPUT_INVALID", "bulk patch cannot replace tags", { reason: "BULK_PATCH_TAGS" });
      s.status = "FROZEN"; const set = sets.get(s.setId)!;
      const operationId = `op-${nextId++}`; const o = { operationId, kind: String(j.kind), status: "QUEUED", setId: s.setId, selectionId: s.selectionId, selectionVersion: String(s.selectionVersion), expectedRevision: String(revision), committedRevision: null, memberIds: set.memberIds.filter((id) => selected(s, set, id)), cursor: 0, confirmed: 0, notExecuted: 0, cancelled: 0, patch: j.patch as Json };
      operations.set(operationId, o); return ok({ ...opDto(o), created: true }, 201);
    }
    if ((m = /^\/catalog\/v1\/operations\/([^/]+)$/.exec(path)) && method === "GET") {
      const t = transfers.get(m[1]); if (t) { t.polls++; if (t.polls >= (options.transferVerifyAfterPolls ?? 1)) { for (const p of t.parts) if (p.dispatchState === "RECEIPT") p.dispatchState = "VERIFIED"; if (t.parts.every((p) => p.dispatchState === "VERIFIED") && ["TRANSFERRING", "VERIFYING"].includes(String(t.status))) t.status = "READY"; } return ok(transferDto(t)); }
      const o = operations.get(m[1]); if (!o) return err(404, "NOT_FOUND", "op"); stepOp(o); return ok(opDto(o));
    }
    if ((m = /^\/catalog\/v1\/operations\/([^/]+)\/cancel$/.exec(path)) && method === "POST") { const o = operations.get(m[1]); if (!o) return err(404, "NOT_FOUND", "op"); if (["QUEUED", "RUNNING"].includes(String(o.status))) o.status = "CANCELLING"; return ok(opDto(o)); }
    if ((m = /^\/catalog\/v1\/operations\/([^/]+)\/resume$/.exec(path)) && method === "POST") { const o = operations.get(m[1]); if (!o) return err(404, "NOT_FOUND", "op"); if (o.status !== "CONFLICT") return err(409, "OPERATION_TRANSITION_INVALID", "not CONFLICT"); if (String(j.revision) !== String(revision)) return err(409, "REVISION_MISMATCH", "revision", { current_revision: String(revision) }); o.status = "RUNNING"; o.expectedRevision = String(revision); o.conflictBatchSeq = null; o.notExecuted = 0; return ok(opDto(o)); }
    if ((m = /^\/catalog\/v1\/operations\/([^/]+)\/parts\/([^/]+)\/capability$/.exec(path)) && method === "POST") { const t = transfers.get(m[1]); if (!t) return err(404, "NOT_FOUND", "op"); const p = t.parts.find((x) => x.partKey === decodeURIComponent(m![2])); if (!p) return err(404, "NOT_FOUND", "part"); if (p.role === "PROJECT") return err(400, "INPUT_INVALID", "PROJECT uses MASTER", { reason: "PROJECT_USES_MASTER" }); if (p.dispatchState !== "PENDING" && p.dispatchState !== "DISPATCHED") return err(409, "PART_STATE_CONFLICT", "state"); const token = `T${String(nextId++).padStart(42, "0")}`; capabilities.set(token, { operationId: t.operationId, partKey: String(p.partKey), used: false }); return ok({ operationId: t.operationId, partKey: p.partKey, token, expiresAt: "x", attempt: (p.attempts as number) + 1, uploadPath: `/catalog/v1/transfer/upload/${token}`, method: "PUT", declaredSize: String(p.size), declaredSha256: p.sha256 ?? null, singleUse: true }, 201); }
    if ((m = /^\/catalog\/v1\/transfer\/upload\/([^/]+)$/.exec(path)) && method === "PUT") { const c = capabilities.get(m[1]); if (!c || c.used) return err(403, "CAPABILITY_INVALID", "token"); c.used = true; const t = transfers.get(c.operationId)!; const p = t.parts.find((x) => x.partKey === c.partKey)!; const size = (body as Blob)?.size ?? Number(headers["Content-Length"] ?? 0); if (size !== Number(p.size)) return err(409, "PART_BYTES_MISMATCH", "size", { declared: String(p.size), received: size }); p.dispatchState = "RECEIPT"; p.attempts = (p.attempts as number) + 1; t.status = "VERIFYING"; return ok(transferDto(t, { upload: { partKey: p.partKey, attempt: p.attempts, state: "RECEIPT", bytesSha256: "x", level: "GATEWAY", verification: "PENDING_PROVIDER" } })); }
    if ((m = /^\/catalog\/v1\/operations\/([^/]+)\/parts\/([^/]+)\/project$/.exec(path)) && method === "PUT") { const t = transfers.get(m[1]); if (!t) return err(404, "NOT_FOUND", "op"); const p = t.parts.find((x) => x.partKey === decodeURIComponent(m![2])); if (!p || p.role !== "PROJECT") return err(400, "INPUT_INVALID", "not a project part"); p.dispatchState = "RECEIPT"; p.attempts = (p.attempts as number) + 1; t.status = "VERIFYING"; return ok(transferDto(t, { upload: { partKey: p.partKey, attempt: p.attempts, state: "RECEIPT", level: "GATEWAY" } })); }
    if ((m = /^\/catalog\/v1\/operations\/([^/]+)\/commit$/.exec(path)) && method === "POST") {
      const t = transfers.get(m[1]); if (!t) return err(404, "NOT_FOUND", "op");
      if (t.status === "COMMITTED") return ok(transferDto(t, { replay: true }));
      if (t.parts.some((p) => p.dispatchState !== "VERIFIED")) return ok(transferDto(t, { pending: t.parts.filter((p) => p.dispatchState !== "VERIFIED").map((p) => p.partKey) }), 202);
      const intent = t.intent as Json;
      if (t.kind === "REPLACE") { const b = beats.get(t.beatId)!; if (String(b.version) !== String(intent.expectedVersion)) { t.status = "CONFLICT"; return err(409, "VERSION_CONFLICT", "beat version changed", { current_version: String(b.version), expected_version: String(intent.expectedVersion) }); } if (intent.metadata) Object.assign(b, intent.metadata as Json); b.version++; }
      else { const md = (intent.metadata as Json) ?? {}; beats.set(t.beatId, { id: t.beatId, version: 1, name: String(md.name ?? "New"), bpm: String(md.bpm ?? ""), key: String(md.key ?? ""), tags: [...((md.tags as string[]) ?? [])], rating: Number(md.rating ?? 0), color: (md.color as string) ?? null, color2: (md.color2 as string) ?? null, state: "ACTIVE", rank: -1000 }); }
      bump(); t.status = "COMMITTED"; t.result = { beatId: t.beatId, version: String(beats.get(t.beatId)!.version), revision: String(revision) }; return ok(transferDto(t));
    }
    if ((m = /^\/catalog\/v1\/operations\/([^/]+)\/cancel$/.exec(path)) && method === "POST" && transfers.has(m[1])) { const t = transfers.get(m[1])!; t.status = t.parts.some((p) => p.dispatchState !== "PENDING") ? "RECONCILE" : "CANCELED"; return ok(transferDto(t)); }
    if (path === "/catalog/v1/tags/rename/preview" && method === "POST") { const from = String(j.from); const all = [...beats.values()]; const hit = (b: FakeBeat) => b.tags.some((t) => t.trim().toLowerCase() === from); return ok({ from, to: String(j.to), countActive: all.filter((b) => b.state === "ACTIVE" && hit(b)).length, countTrash: all.filter((b) => b.state === "TRASH" && hit(b)).length, mergesInto: all.some((b) => b.tags.some((t) => t.trim().toLowerCase() === String(j.to))), revision: String(revision), epoch, authorityEra: era }); }
    if (path === "/catalog/v1/tags/rename" && method === "POST") { const from = String(j.from); const members = [...beats.values()].filter((b) => b.tags.some((t) => t.trim().toLowerCase() === from)).map((b) => b.id); const operationId = `op-${nextId++}`; const o = { operationId, kind: "TAG_RENAME", status: "QUEUED", setId: null, selectionId: null, selectionVersion: null, expectedRevision: String(revision), committedRevision: null, memberIds: members, cursor: 0, confirmed: 0, notExecuted: 0, cancelled: 0, rename: { from, to: String(j.to) } }; operations.set(operationId, o); return ok({ ...opDto(o), created: true }, 201); }
    if (path === "/catalog/v1/facets" && method === "GET") { const scope = u.searchParams.get("scope") ?? "ACTIVE"; const f = new Map<string, number>(); for (const b of beats.values()) if (b.state === scope) for (const t of new Set(b.tags.map((x) => x.trim().toLowerCase()))) f.set(t, (f.get(t) ?? 0) + 1); const items = [...f.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key, c]) => ({ key, label: key, count: c, representativeBeatId: "g0" })); return ok({ items, startOrdinal: 0, totalFacets: items.length, nextCursor: null, revision: String(revision) }); }
    return err(404, "NOT_FOUND", `no route ${method} ${path}`);
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body; const parsed = typeof body === "string" ? JSON.parse(body) : body;
    const r = await handle(init?.method ?? "GET", String(input), headers, parsed);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;

  return {
    fetchImpl, counters, legacy, beats,
    revision: () => String(revision),
    externalEdit(beatId: string, patch: Partial<FakeBeat> = { name: "Edited elsewhere" }) { const b = beats.get(beatId)!; Object.assign(b, patch); b.version++; bump(); },
    setFailure(f: { code: string; status: number; route: RegExp } | null) { fail = f; },
    selection: (id: string) => selections.get(id),
    operation: (id: string) => operations.get(id),
    transfer: (id: string) => transfers.get(id),
    /** Espía legacy: un runtime INDEX que jamás debe usarse en la rama POSTGRES. */
    legacyRuntime: { async getLibraryIndex() { legacy.getLibraryIndex++; return { manifest: {}, messageId: 1 }; }, async replaceLibraryIndex() { legacy.replaceLibraryIndex++; return { messageId: 2, previousMessageId: 1, beatCount: 0 }; } },
  };
}
