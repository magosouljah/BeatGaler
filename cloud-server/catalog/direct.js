'use strict';
// Direct B (Web) — plano de datos navegador ↔ Telegram para el catálogo PostgreSQL (CONTRATO C7.3–C7.9; NATIVO r2.1 §8.5/§8.6 con la
// excepción aprobada por el propietario: el cliente Web SÍ conoce chat y message_id; nunca recibe bot_token, api_hash ni la clave
// permanente del bot). PostgreSQL sigue siendo la única autoridad; no hay INDEX, puntero ni ruteo en Telegram.
//
//  - Sesión: reutiliza el límite de autorización temporal del legacy (el navegador genera su clave MTProto temporal; el servidor solo
//    entrega el bloque cifrado que la vincula a la clave permanente del bot ya asignado a la biblioteca: vaults.transport_bot_id).
//    El bot de la biblioteca es el MISMO que usa el gateway; no se reasigna ni se limita su reparto (D1 aprobado: sin límites nuevos).
//  - E77: es el ÚNICO transporte de archivos (MASTER, WAV, portada, PROJECT y MAIN). El Cloud no envía ni descarga bytes.
//  - Envío: el servidor persiste ANTES del efecto la identidad (random_id, remitente, chat) y marca el despacho; el navegador envía con
//    ese random_id y el caption `catalog:v1 op=… part=…`; después PUT recibo. La verificación independiente del mensaje (worker T10,
//    nivel PROVIDER) y el commit no cambian. Un recibo del navegador es un candidato, nunca una prueba (C7.4).
//  - Reintentos: tras un fallo SIN efecto (rechazo/flood/subida fallida) se pide otro ticket y se conserva el mismo random_id.
//    Un envío incierto, un ticket sin informe o un recibo no persistido → RECONCILE; NO se reenvía (RESEND_POLICY.uncertain = BLOCKED,
//    C7.8; ver E70: el contrato vigente impide reenviar tras una incertidumbre hasta el dictamen de Sol).
//  - Duplicados tardíos: un segundo mensaje con el mismo marcador nunca se convierte en referencia: putReceipt rechaza un recibo
//    distinto (RECEIPT_CONFLICT) y la operación ya cerrada rechaza cualquier recibo (OPERATION_TRANSITION_INVALID).
const crypto = require('crypto');
const { requireUserId, partJobId } = require('./contract');
const { canonicalJson } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const { createLibraryTx } = require('./library-tx');
const { captionFor } = require('./transport-gateway');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PART_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const INFLIGHT = Object.freeze(['PREPARED', 'TRANSFERRING', 'VERIFYING']);
// Resultados que el navegador puede informar de un ticket. SENT solo existe por la ruta de recibo.
const NO_EFFECT = Object.freeze({ REJECTED: 'REJECTED', UPLOAD_FAILED: 'UPLOAD_FAILED', PERMANENT: 'PERMANENT', REVOKED: 'REVOKED' });
const SESSION_PROTOCOL = 'catalog-v1-direct';
const TICKET_TTL_MS = 30 * 60_000;

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const ticketHash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const PART_SQL = `SELECT p.part_key, p.role, p.filename, p.mime, p.declared_size::text AS declared_size, p.declared_sha256, p.random_id, p.sender_id, p.chat_id, p.dispatch_state, p.attempts,
    o.status AS op_status, o.authority_epoch::text AS op_epoch
  FROM catalog_operation_parts p JOIN catalog_transfer_operations o ON o.user_id = p.user_id AND o.operation_id = p.operation_id
  WHERE p.user_id = $1 AND p.operation_id = $2 AND p.part_key = $3`;

function createCatalogDirect({ pool = null, authority = null, operations = null, sessionSource = null, bindBuilder = null, resolveProjectAccess = null, sessionTtlCapS = 15 * 60, now = () => new Date(), randomBytes = crypto.randomBytes, randomUUID = () => crypto.randomUUID(), log = () => {} } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogDirect requires a pool');
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createCatalogDirect requires the catalog authority');
  if (!operations || typeof operations.markDispatched !== 'function' || typeof operations.putReceipt !== 'function') throw new Error('createCatalogDirect requires catalog operations');
  const metrics = { sessions: 0, sessionRejected: 0, tickets: 0, reported: 0, receipts: 0, uncertain: 0, conflicts: 0, prewarmed: 0, lastSessionMs: 0 };

  const libraryTx = createLibraryTx({ pool, authority, variant: 'direct' });
  const { translateError: sqlError } = libraryTx;
  async function journal(sql, params) { try { return await pool.query(sql, params); } catch (error) { throw sqlError(error); } }
  async function loadPart(client, uid, operationId, partKey, { forUpdate = false } = {}) {
    const r = await client.query(`${PART_SQL}${forUpdate ? ' FOR UPDATE OF p' : ''}`, [uid, operationId, partKey]);
    if (!r.rows.length) throw notFound('part');
    return r.rows[0];
  }
  const checkIds = (operationId, partKey) => { if (typeof operationId !== 'string' || !ID_RE.test(operationId) || typeof partKey !== 'string' || !PART_RE.test(partKey)) throw inputInvalid('OPERATION_OR_PART'); };
  const enqueueReconcile = (uid, operationId, partKey) => journal(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'TRANSFER_RECONCILE', $3, $4) ON CONFLICT (job_id) DO NOTHING`,
    [partJobId('reconcile', operationId, partKey), uid, operationId, canonicalJson({ partKey })]);

  // ---------- POST /catalog/v1/direct/session ----------
  // Sin tempAuthMetadata → bootstrap (dc, api_id, bot esperado); con él → bloque de vinculación. Sin lease legacy, sin INDEX, sin MASTER.
  async function startSession({ userId, tempAuthMetadata = null } = {}) {
    if (typeof sessionSource !== 'function' || typeof bindBuilder !== 'function') throw new CatalogQueryError('TRANSFER_UNAVAILABLE', 503, 'direct transport is not configured', { reason: 'NO_DIRECT' });
    const uid = requireUserId(userId);
    const ctx = await authority.resolveContext({ userId: uid }); // 404/409 fail-closed si no hay biblioteca nativa
    if (ctx.migration_state !== 'IDLE') throw new CatalogQueryError('LIBRARY_FROZEN', 409, 'library is not accepting transfers', { migration_state: ctx.migration_state });
    if (!ctx.chat_id) throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'library has no CURRENT chat', { reason: 'NO_CURRENT_CHAT' });
    let v;
    try { v = (await pool.query('SELECT v.transport_bot_id AS bot_id, b.quarantined, b.rotation_pending FROM vaults v LEFT JOIN transport_bots b ON b.id = v.transport_bot_id WHERE v.user_id = $1', [uid])).rows[0]; } catch (error) { throw sqlError(error); }
    if (!v || !v.bot_id) throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'library has no transport bot assigned', { reason: 'NO_SENDER' });
    if (v.quarantined || v.rotation_pending) { metrics.sessionRejected++; throw new CatalogQueryError('TRANSFER_UNAVAILABLE', v.quarantined ? 403 : 503, 'the assigned transport bot is unavailable', { reason: v.quarantined ? 'BOT_QUARANTINED' : 'BOT_ROTATION_PENDING' }); }
    if (tempAuthMetadata !== null) {
      // Misma ventana que el límite legacy (30 s … 15 min); fuera de ella no se emite ningún bloque de vinculación.
      const exp = Number(tempAuthMetadata && tempAuthMetadata.expiresAt); const t = Math.floor(now().getTime() / 1000);
      if (!Number.isInteger(exp) || exp <= t + 30 || exp > t + sessionTtlCapS) { metrics.sessionRejected++; throw inputInvalid('TEMP_AUTH_EXPIRY'); }
    }
    const t0 = Date.now();
    const session = await sessionSource({ botId: String(v.bot_id), chatId: String(ctx.chat_id), userId: uid });
    const out = await bindBuilder(session, tempAuthMetadata);
    metrics.sessions++; metrics.lastSessionMs = Date.now() - t0;
    // E73: una autorización lenta delata un bot sin precalentar (handshake permanente dentro de la petición del usuario).
    if (metrics.lastSessionMs >= 2000) log(`[catalog-direct] slow session authorization ms=${metrics.lastSessionMs} bind=${tempAuthMetadata !== null}`);
    return { ...out, protocol: SESSION_PROTOCOL, catalog: { authority_era: ctx.authority_era, authority_epoch: ctx.authority_epoch, chat_id: String(ctx.chat_id) }, index_pointer: null };
  }

  // E73 (C): precalienta en segundo plano la autorización permanente (handshake MTProto + login del bot) de los bots que YA sirven bibliotecas
  // nativas — nunca el pool completo. Sin vinculación (metadata null): no emite claves temporales ni toca chats. Secuencial, espaciado y fail-soft:
  // el primer fallo (flood, red, credencial) detiene la tanda para no insistir contra Telegram; el arranque y /readyz no dependen de esto.
  async function prewarm({ maxBots = 3, gapMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (typeof sessionSource !== 'function' || typeof bindBuilder !== 'function') return [];
    const n = Math.max(0, Math.min(8, Math.floor(Number(maxBots) || 0)));
    if (!n) return [];
    let rows;
    try {
      rows = (await pool.query(`SELECT v.transport_bot_id AS bot_id, count(*)::int AS libraries, min(c.chat_id) AS chat_id
        FROM catalog_libraries l JOIN vaults v ON v.user_id = l.user_id
        JOIN catalog_library_chats c ON c.user_id = l.user_id AND c.state = 'CURRENT'
        LEFT JOIN transport_bots b ON b.id = v.transport_bot_id
        WHERE l.authority = 'POSTGRES' AND v.transport_bot_id IS NOT NULL AND coalesce(b.quarantined, false) = false AND coalesce(b.rotation_pending, false) = false
        GROUP BY v.transport_bot_id ORDER BY libraries DESC, v.transport_bot_id LIMIT $1`, [n])).rows;
    } catch (error) { log(`[catalog-direct] prewarm skipped code=${String((error && error.code) || 'ERROR').slice(0, 40)}`); return []; }
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      if (i) await sleep(gapMs);
      const botId = String(rows[i].bot_id); const t0 = Date.now();
      try { await bindBuilder(await sessionSource({ botId, chatId: String(rows[i].chat_id) }), null); metrics.prewarmed++; out.push({ botId, ok: true, ms: Date.now() - t0 }); }
      catch (error) { out.push({ botId, ok: false, ms: Date.now() - t0, code: String((error && (error.code || error.name)) || 'ERROR').slice(0, 60), detail: String((error && error.message) || '').replace(/\d{6,12}:[A-Za-z0-9_-]{30,}/g, '<token>').slice(0, 160) }); break; }
    }
    log(`[catalog-direct] prewarm ${JSON.stringify(out)}`);
    return out;
  }

  // E77: PROJECT viaja por Direct B con el bot (sin MASTER). El plan —permiso y tope de bytes— se comprueba ANTES de emitir el ticket contra el
  // tamaño declarado; el tamaño REAL lo comprueba el worker contra el proveedor (el documento debe medir exactamente lo declarado).
  async function assertProjectAllowed(uid, operationId, partKey) {
    const part = (await journal(PART_SQL, [uid, operationId, partKey])).rows[0];
    if (!part) throw notFound('part');
    if (part.role !== 'PROJECT') return;
    if (typeof resolveProjectAccess !== 'function') throw new CatalogQueryError('PROJECT_ACCESS_UNAVAILABLE', 503, 'PROJECT Access resolver is unavailable', { reason: 'NO_ACCESS' });
    let access;
    try { access = await resolveProjectAccess(uid); } catch (error) { throw new CatalogQueryError(error?.code || 'PROJECT_ACCESS_UNAVAILABLE', Number(error?.status) || 503, String(error?.message || 'PROJECT Access is unavailable'), {}); }
    const maxBytes = Number(access && access.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new CatalogQueryError('PROJECT_ACCESS_UNAVAILABLE', 503, 'PROJECT Access did not return a byte ceiling', {});
    if (Number(part.declared_size) > maxBytes) throw new CatalogQueryError('PROJECT_TOO_LARGE', 413, 'PROJECT exceeds the plan byte limit', { declared: part.declared_size, max_bytes: maxBytes });
  }

  // ---------- POST /operations/:id/parts/:partKey/send-ticket ----------
  // Equivale a emitir y redimir una capacidad de subida: un solo ticket vivo por parte; markDispatched ANTES de devolver la identidad.
  async function issueSendTicket({ userId, era, epoch, operationId, partKey } = {}) {
    checkIds(operationId, partKey);
    await assertProjectAllowed(requireUserId(userId), operationId, partKey);
    const hash = ticketHash(randomBytes(32));
    const planned = await libraryTx.mutate(userId, { era, epoch }, async ({ client, ctx, uid }) => {
      const part = await loadPart(client, uid, operationId, partKey, { forUpdate: true });
      if (!INFLIGHT.includes(part.op_status)) throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, `operation is ${part.op_status}`, { status: part.op_status });
      if (!['PENDING', 'DISPATCHED'].includes(part.dispatch_state)) throw new CatalogQueryError('PART_STATE_CONFLICT', 409, 'part already has a receipt or verification', { dispatch_state: part.dispatch_state });
      // Un ticket anterior sin informe (cliente caído tras enviar) o con envío incierto no admite otro ticket: C7.8 (BLOQUEADO → RECONCILE).
      const open = await client.query(`SELECT attempt, status, outcome FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 AND part_key = $3
        AND ((status = 'CONSUMED' AND outcome = 'UNCERTAIN') OR (status = 'REDEEMED' AND $4 = 'DISPATCHED'))`, [uid, operationId, partKey, part.dispatch_state]);
      if (open.rows.length) {
        await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'TRANSFER_RECONCILE', $3, $4) ON CONFLICT (job_id) DO NOTHING`, [partJobId('reconcile', operationId, partKey), uid, operationId, canonicalJson({ partKey })]);
        throw Object.assign(new CatalogQueryError('PART_UNCERTAIN', 409, 'a previous dispatch of this part has no reported outcome or is uncertain; reconciliation is pending and no resend is allowed', { partKey, reconcile: true, attempts: open.rows.length }), { commit: true });
      }
      await client.query(`UPDATE catalog_transfer_capabilities SET status = 'REVOKED', resolved_at = now(), last_error = 'SUPERSEDED' WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND status = 'ISSUED'`, [uid, operationId, partKey]);
      const attempt = (await client.query('SELECT coalesce(max(attempt), 0)::int + 1 AS n FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 AND part_key = $3', [uid, operationId, partKey])).rows[0].n;
      const ttlS = Math.round(TICKET_TTL_MS / 1000);
      await client.query(`INSERT INTO catalog_transfer_capabilities(capability_hash, user_id, operation_id, part_key, direction, authority_epoch, attempt, status, redeemed_at, expires_at)
        VALUES ($1, $2, $3, $4, 'UPLOAD', $5::bigint, $6, 'REDEEMED', now(), now() + make_interval(secs => $7))`, [hash, uid, operationId, partKey, ctx.authority_epoch, attempt, ttlS]);
      return { part, attempt };
    });
    let d;
    try { d = await operations.markDispatched({ userId, era, epoch, operationId, partKey }); } catch (error) {
      await journal(`UPDATE catalog_transfer_capabilities SET status = 'FAILED', outcome = 'ABORTED', resolved_at = now(), last_error = $2 WHERE capability_hash = $1 AND status = 'REDEEMED'`, [hash, String(error?.code || 'DISPATCH_FAILED').slice(0, 200)]).catch(() => {});
      throw error;
    }
    metrics.tickets++;
    const { part, attempt } = planned;
    return {
      operationId, partKey, attempt, randomId: d.randomId, caption: captionFor({ operationId, partKey }), chatId: String(part.chat_id), botId: String(part.sender_id),
      filename: part.filename, mime: part.mime || 'application/octet-stream', size: Number(part.declared_size), declaredSha256: part.declared_sha256 || null, level: 'CLIENT',
    };
  }

  // ---------- POST /operations/:id/parts/:partKey/send-report ----------
  // Resultado de un envío SIN recibo. SENT no existe aquí (va por el recibo). Cualquier otro código desconocido es incierto.
  async function reportSend({ userId, era, epoch, operationId, partKey, attempt, outcome, code = null, retryAfterMs = null } = {}) {
    checkIds(operationId, partKey);
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw inputInvalid('ATTEMPT');
    const o = typeof outcome === 'string' ? outcome : '';
    const known = Object.prototype.hasOwnProperty.call(NO_EFFECT, o);
    if (!known && o !== 'UNCERTAIN') throw inputInvalid('OUTCOME');
    const reason = typeof code === 'string' ? code.slice(0, 200) : null;
    const wait = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0 ? Math.min(Number(retryAfterMs), 3_600_000) : 0;
    const r = await libraryTx.mutate(userId, { era, epoch }, async ({ client, uid }) => {
      await loadPart(client, uid, operationId, partKey, { forUpdate: true });
      const cap = (await client.query(`SELECT capability_hash, status FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND attempt = $4 FOR UPDATE`, [uid, operationId, partKey, attempt])).rows[0];
      if (!cap) throw notFound('ticket');
      if (cap.status !== 'REDEEMED') return { replay: true, status: cap.status };
      if (known) await client.query(`UPDATE catalog_transfer_capabilities SET status = 'FAILED', outcome = $2, resolved_at = now(), last_error = $3 WHERE capability_hash = $1`, [cap.capability_hash, NO_EFFECT[o], reason]);
      else await client.query(`UPDATE catalog_transfer_capabilities SET status = 'CONSUMED', outcome = 'UNCERTAIN', resolved_at = now(), last_error = $2 WHERE capability_hash = $1`, [cap.capability_hash, reason]);
      return { replay: false };
    });
    metrics.reported++;
    if (!known) { metrics.uncertain++; await enqueueReconcile(requireUserId(userId), operationId, partKey); return { state: 'UNCERTAIN', reconcile: true, resend: 'BLOCKED', retryAfterMs: wait || 60_000, replay: r.replay === true }; }
    // Fallo sin efecto: la misma identidad (random_id) sigue vigente; el cliente puede pedir otro ticket tras la espera.
    return { state: o, retry: o === 'REJECTED' || o === 'UPLOAD_FAILED' ? 'SAME_IDENTITY' : 'NONE', retryAfterMs: wait || (o === 'REJECTED' || o === 'UPLOAD_FAILED' ? 5000 : 0), replay: r.replay === true };
  }

  // ---------- PUT /operations/:id/parts/:partKey/direct-receipt ----------
  // Recibo candidato del navegador + cierre del ticket. El worker T10 verifica con el proveedor (PROVIDER); este recibo no prueba nada.
  async function submitReceipt({ userId, era, epoch, operationId, partKey, attempt, receipt } = {}) {
    checkIds(operationId, partKey);
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw inputInvalid('ATTEMPT');
    let dto;
    try { dto = await operations.putReceipt({ userId, era, epoch, operationId, partKey, receipt }); } catch (error) {
      if (error && ['RECEIPT_CONFLICT', 'OPERATION_TRANSITION_INVALID'].includes(error.code)) metrics.conflicts++;
      else if (error && !(error instanceof CatalogQueryError && error.status < 500)) { metrics.uncertain++; await journal(`UPDATE catalog_transfer_capabilities SET status = 'CONSUMED', outcome = 'UNCERTAIN', resolved_at = now(), last_error = 'RECEIPT_PERSIST_FAILED' WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND attempt = $4 AND status = 'REDEEMED'`, [requireUserId(userId), operationId, partKey, attempt]).catch(() => {}); await enqueueReconcile(requireUserId(userId), operationId, partKey).catch(() => {}); }
      throw error;
    }
    await journal(`UPDATE catalog_transfer_capabilities SET status = 'CONSUMED', outcome = 'SENT', resolved_at = now() WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND attempt = $4 AND status = 'REDEEMED'`, [requireUserId(userId), operationId, partKey, attempt]);
    metrics.receipts++;
    return { ...dto, upload: { partKey, attempt, state: 'RECEIPT', level: 'CLIENT', verification: 'PENDING_PROVIDER' } };
  }

  // ---------- GET /operations/:id/attempts ----------
  // Estado de intentos por parte (sin ticket ni hash): el cliente ve si hay un envío incierto pendiente de reconciliación.
  async function listAttempts({ userId, operationId } = {}) {
    const uid = requireUserId(userId);
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    const q = await journal('SELECT part_key, attempt, status, outcome, issued_at, resolved_at FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 ORDER BY part_key, attempt', [uid, operationId]);
    return { operationId, attempts: q.rows.map((a) => ({ partKey: a.part_key, attempt: a.attempt, status: a.status, outcome: a.outcome, issuedAt: a.issued_at, resolvedAt: a.resolved_at })) };
  }

  return Object.freeze({ startSession, prewarm, issueSendTicket, reportSend, submitReceipt, listAttempts, metrics, SESSION_PROTOCOL, TICKET_TTL_MS });
}

let configured = null;
// Access para PROJECT (mismo criterio que project-access.js): plan con upload_project y tope de bytes vigente.
function createProjectAccessResolver({ resolveUserAccess } = {}) {
  if (typeof resolveUserAccess !== 'function') throw new Error('resolveUserAccess is required');
  return async (userId) => {
    const access = await resolveUserAccess({ id: userId });
    const maxBytes = access && access.quotas ? access.quotas.max_project_zip_bytes : null;
    if (!access || !access.capabilities || !access.capabilities.upload_project || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw Object.assign(new Error('PROJECT upload is not available on this plan.'), { code: 'PROJECT_UPLOAD_DENIED', status: 403 });
    }
    return { maxBytes };
  };
}

function configureCatalogDirect(options = null) { configured = options && options.pool && options.authority && options.operations ? createCatalogDirect(options) : null; return configured; }
function currentCatalogDirect() { return configured; }

module.exports = { SESSION_PROTOCOL, createProjectAccessResolver, createCatalogDirect, configureCatalogDirect, currentCatalogDirect };
