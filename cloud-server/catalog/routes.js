'use strict';
// T06 — Rutas HTTP /catalog/v1 de lectura (CONTRATO C5, NATIVO r2.1 §3.3, C12-r4). Solo glue HTTP: autenticación Cloud
// existente (server-side), delegación a authority/queries y mapeo estable de errores. No importa transporte ni Telegram.
//  - GET  /catalog/v1/context                      resolveContext (solo lectura) → 200 | 404 LIBRARY_NOT_PROVISIONED | 409 | 503
//  - POST /catalog/v1/library/provision            provisionLibrary idempotente → 201 {created:true} | 200 {created:false} | 409 | 503
//  - GET  /catalog/v1/beats                        lista keyset (cursor/edge=last/resumeCursor) → 200 | 400 | 409 CURSOR_STALE | 413 | 503
//  - GET  /catalog/v1/beats/:id                    detalle (ETag débil por versión) → 200 | 404
//  - GET  /catalog/v1/beats/:id/files              versiones/partes visibles (≤100) → 200 | 404
//  - GET  /catalog/v1/navigation/legacy            resolver bgPage acotado (C12 §5.2) → 200 | 400 LEGACY_OFFSET_INVALID | 409 LEGACY_OFFSET_UNRESOLVABLE
//  - GET  /catalog/v1/facets, GET /catalog/v1/facets/active?key=…  facetas globales (C12-r4 §6)
//  - POST /catalog/v1/query-sets, GET /:id, POST /:id/cancel, POST /:id/release   conjuntos (C12-r4 §3); los pasos los programa T10
//  - T12: POST /operations/:id/parts/:partKey/capability (capacidad opaca de subida), PUT /transfer/upload/:token (bytes de la parte),
//    PUT /operations/:id/parts/:partKey/project (PROJECT por MASTER), GET /operations/:id/attempts. El cuerpo de los PUT es el stream crudo.
// Todo error se responde como JSON {error, code, detail}; nunca 200 vacío ante error (C5).
// Cualquier entrada con cerco legacy (410 LEGACY_CLIENT_UNSUPPORTED) no pasa por aquí: estas rutas son solo nativas.

const express = require('express');
const { CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');

const CATALOG_PREFIX = '/catalog/v1';
const API_LIMITS = Object.freeze({ listDefault: 100, listMax: 240, filesMax: 100, facetsMax: 240, batchMax: 50, bodyMetadataBytes: 64 * 1024, bodyBatchBytes: 256 * 1024, pageBytes: 2 * 1024 * 1024, legacyOffsetMax: 10000 });

function respondError(res, error) {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError) {
    const ra = error.detail && Number(error.detail.retry_after_ms);
    if (Number.isFinite(ra) && ra > 0) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ra / 1000))));
    return res.status(error.status).json({ error: error.message, code: error.code, detail: error.detail || {} });
  }
  if (error && error.code === 'CATALOG_TENANT_REQUIRED') return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'UNAUTHENTICATED' });
  // Error inesperado: nunca 200 ni lista vacía; 500 con mensaje opaco.
  return res.status(500).json({ error: 'catalog request failed', code: 'CATALOG_INTERNAL_ERROR' });
}

// Cabeceras de escritura C5: Idempotency-Key, X-Catalog-Era, X-Catalog-Epoch (ausentes → 428 PRECONDITION_REQUIRED).
function writeHeaders(req) {
  const key = req.get('idempotency-key'); const era = req.get('x-catalog-era'); const epoch = req.get('x-catalog-epoch');
  if (!key || !era || !epoch) throw new CatalogQueryError('PRECONDITION_REQUIRED', 428, 'Idempotency-Key, X-Catalog-Era and X-Catalog-Epoch headers are required', { missing: [!key && 'Idempotency-Key', !era && 'X-Catalog-Era', !epoch && 'X-Catalog-Epoch'].filter(Boolean) });
  return { idempotencyKey: key, era, epoch };
}
function eraHeaders(req) {
  const era = req.get('x-catalog-era'); const epoch = req.get('x-catalog-epoch');
  if (!era || !epoch) throw new CatalogQueryError('PRECONDITION_REQUIRED', 428, 'X-Catalog-Era and X-Catalog-Epoch headers are required', {});
  return { era, epoch };
}
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function createCatalogRouter({ authority = null, queries = null, commands = null, operations = null, transport = null, playback = null, media = null, authenticate, log = () => {} } = {}) {
  if (typeof authenticate !== 'function') throw new Error('createCatalogRouter requires authenticate(req, res) → user | null');
  const router = express.Router();
  router.use(CATALOG_PREFIX, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Sin autoridad nativa montada (flag apagado, control-plane json o sin PG): 503 CATALOG_UNAVAILABLE en toda la API (C1 flags).
  if (!authority || !queries) {
    router.use(CATALOG_PREFIX, (_req, res) => res.status(503).json({ error: 'catalog is unavailable (NOT_MOUNTED)', code: 'CATALOG_UNAVAILABLE', detail: { reason: 'NOT_MOUNTED' } }));
    return router;
  }

  const handle = (fn) => async (req, res) => {
    const user = authenticate(req, res);
    if (!user) return; // 401 ya respondido por la autenticación existente
    try {
      const result = await fn(req, res, String(user.id));
      if (result && !res.headersSent) res.status(result.status || 200).json(result.body);
    } catch (error) {
      if (!(error instanceof CatalogAuthorityError) && !(error instanceof CatalogQueryError)) log('[catalog] unexpected error', error?.message || error);
      if (!res.headersSent) respondError(res, error);
    }
  };

  router.get(`${CATALOG_PREFIX}/context`, handle(async (_req, _res, userId) => {
    const context = await authority.resolveContext({ userId });
    return { body: { ...context, capabilities: { read: true, provision: false, mutate: false, operations: false }, limits: API_LIMITS } };
  }));
  router.post(`${CATALOG_PREFIX}/library/provision`, handle(async (_req, _res, userId) => {
    const r = await authority.provisionLibrary({ userId });
    return { status: r.created ? 201 : 200, body: { created: r.created, context: r.context } };
  }));
  router.get(`${CATALOG_PREFIX}/beats`, handle(async (req, _res, userId) => ({ body: await queries.listBeats({ userId, query: req.query }) })));
  router.get(`${CATALOG_PREFIX}/navigation/legacy`, handle(async (req, _res, userId) => ({ body: await queries.resolveLegacyNavigation({ userId, query: req.query }) })));
  router.get(`${CATALOG_PREFIX}/facets`, handle(async (req, _res, userId) => ({ body: await queries.listFacets({ userId, query: req.query }) })));
  router.get(`${CATALOG_PREFIX}/facets/active`, handle(async (req, _res, userId) => {
    const keys = req.query.key === undefined ? [] : Array.isArray(req.query.key) ? req.query.key : [req.query.key];
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'ACTIVE';
    return { body: await queries.activeFacets({ userId, keys }, scope) };
  }));
  router.get(`${CATALOG_PREFIX}/beats/:id`, handle(async (req, res, userId) => {
    const beat = await queries.getBeat({ userId, beatId: req.params.id });
    res.setHeader('ETag', beat.etag);
    return { body: beat };
  }));
  router.get(`${CATALOG_PREFIX}/beats/:id/files`, handle(async (req, _res, userId) => ({ body: await queries.listBeatFiles({ userId, beatId: req.params.id, query: req.query }) })));
  router.post(`${CATALOG_PREFIX}/query-sets`, handle(async (req, _res, userId) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await queries.createQuerySet({ userId, query: body.query && typeof body.query === 'object' ? body.query : {}, consumer: body.consumer || {} });
    return { status: r.created ? 201 : 200, body: r };
  }));
  router.get(`${CATALOG_PREFIX}/query-sets/:id`, handle(async (req, _res, userId) => ({ body: await queries.getQuerySet({ userId, setId: req.params.id }) })));
  router.post(`${CATALOG_PREFIX}/query-sets/:id/cancel`, handle(async (req, _res, userId) => ({ body: await queries.cancelQuerySet({ userId, setId: req.params.id }) })));
  router.post(`${CATALOG_PREFIX}/query-sets/:id/release`, handle(async (req, _res, userId) => ({ body: await queries.releaseQuerySet({ userId, setId: req.params.id }) })));
  if (commands) {
    // T07 — mutaciones (C5/C6, r4 §4/§6). Validación antes de la transacción; errores estables; nunca Telegram.
    router.patch(`${CATALOG_PREFIX}/beats/:id`, handle(async (req, res, userId) => {
      const h = writeHeaders(req); const b = body(req);
      const r = await commands.patchBeat({ userId, beatId: req.params.id, ...h, expectedVersion: b.expectedVersion, ifMatch: req.get('if-match') || null, patch: b.patch ?? b.set });
      if (r.beat) res.setHeader('ETag', `W/"${r.beat.id.length}-${r.beat.version}"`);
      return { body: r };
    }));
    router.post(`${CATALOG_PREFIX}/beats/trash`, handle(async (req, _res, userId) => ({ body: await commands.trashBeats({ userId, ...writeHeaders(req), items: body(req).items }) })));
    router.post(`${CATALOG_PREFIX}/beats/restore`, handle(async (req, _res, userId) => ({ body: await commands.restoreBeats({ userId, ...writeHeaders(req), items: body(req).items }) })));
    router.post(`${CATALOG_PREFIX}/selections`, handle(async (req, _res, userId) => { const b = body(req); return { status: 201, body: await commands.createSelection({ userId, ...eraHeaders(req), setId: b.setId, sort: b.sort ?? 'rating', defaultSelected: b.defaultSelected ?? false, consumerId: b.consumerId }) }; }));
    router.get(`${CATALOG_PREFIX}/selections/:id`, handle(async (req, _res, userId) => {
      const beatIds = req.query.beatId === undefined ? [] : Array.isArray(req.query.beatId) ? req.query.beatId : [req.query.beatId];
      return { body: await commands.getSelection({ userId, selectionId: req.params.id, beatIds }) };
    }));
    router.post(`${CATALOG_PREFIX}/selections/:id/ops`, handle(async (req, _res, userId) => { const b = body(req); return { body: await commands.applySelectionOp({ userId, ...writeHeaders(req), selectionId: req.params.id, selectionVersion: b.selectionVersion, op: b.op }) }; }));
    router.post(`${CATALOG_PREFIX}/selections/:id/release`, handle(async (req, _res, userId) => ({ body: await commands.releaseSelection({ userId, ...eraHeaders(req), selectionId: req.params.id }) })));
    router.post(`${CATALOG_PREFIX}/tags/rename/preview`, handle(async (req, _res, userId) => { const b = body(req); return { body: await commands.previewTagRename({ userId, from: b.from, to: b.to }) }; }));
    router.post(`${CATALOG_PREFIX}/tags/rename`, handle(async (req, _res, userId) => { const b = body(req); const r = await commands.createOperation({ userId, ...writeHeaders(req), kind: 'TAG_RENAME', rename: { from: b.from, to: b.to } }); return { status: r.created ? 201 : 200, body: r }; }));
    router.post(`${CATALOG_PREFIX}/operations`, handle(async (req, res, userId) => {
      const b = body(req);
      if (['IMPORT', 'REPLACE', 'PURGE'].includes(b.kind)) {
        if (!operations) return { status: 501, body: { error: 'transfer operations are not mounted', code: 'NOT_IMPLEMENTED' } };
        const r = await operations.createOperation({ userId, ...writeHeaders(req), intent: b });
        return { status: r.created ? 201 : 200, body: r };
      }
      if (!['BULK_PATCH', 'BULK_TRASH', 'BULK_RESTORE', 'TAG_RENAME'].includes(b.kind)) return { status: 400, body: { error: `unknown operation kind ${String(b.kind)}`, code: 'INPUT_INVALID', detail: { reason: 'OPERATION_KIND' } } };
      const r = await commands.createOperation({ userId, ...writeHeaders(req), kind: b.kind, selectionId: b.selectionId, selectionVersion: b.selectionVersion, patch: b.patch, rename: b.rename });
      return { status: r.created ? 201 : 200, body: r };
    }));
    const isTransfer = (id) => typeof id === 'string' && id.startsWith('top-');
    router.get(`${CATALOG_PREFIX}/operations/:id`, handle(async (req, _res, userId) => {
      if (isTransfer(req.params.id)) { if (!operations) throw new CatalogQueryError('NOT_FOUND', 404, 'operation is not accessible', {}); return { body: await operations.getOperation({ userId, operationId: req.params.id }) }; }
      return { body: await commands.getOperation({ userId, operationId: req.params.id, detailsAfter: typeof req.query.detailsAfter === 'string' ? req.query.detailsAfter : null }) };
    }));
    router.post(`${CATALOG_PREFIX}/operations/:id/cancel`, handle(async (req, _res, userId) => {
      if (isTransfer(req.params.id) && operations) return { body: await operations.cancelOperation({ userId, ...eraHeaders(req), operationId: req.params.id }) };
      return { body: await commands.cancelOperation({ userId, ...eraHeaders(req), operationId: req.params.id }) };
    }));
    if (operations) {
      // T09 — transferencias C7: recibo candidato, commit idempotente (202/200/409), reserva (renovar/readmitir), despacho (gateway).
      router.put(`${CATALOG_PREFIX}/operations/:id/parts/:partKey/receipt`, handle(async (req, _res, userId) => ({ body: await operations.putReceipt({ userId, ...eraHeaders(req), operationId: req.params.id, partKey: req.params.partKey, receipt: body(req) }) })));
      router.post(`${CATALOG_PREFIX}/operations/:id/commit`, handle(async (req, _res, userId) => { const r = await operations.commitOperation({ userId, ...eraHeaders(req), operationId: req.params.id }); return { status: r.status, body: r.operation }; }));
      router.post(`${CATALOG_PREFIX}/operations/:id/reservation/renew`, handle(async (req, _res, userId) => ({ body: await operations.renewReservation({ userId, ...eraHeaders(req), operationId: req.params.id }) })));
      router.post(`${CATALOG_PREFIX}/operations/:id/reservation/readmit`, handle(async (req, _res, userId) => ({ body: await operations.readmitReservation({ userId, ...eraHeaders(req), operationId: req.params.id }) })));
      router.post(`${CATALOG_PREFIX}/operations/:id/parts/:partKey/dispatch`, handle(async (req, _res, userId) => ({ body: await operations.markDispatched({ userId, ...eraHeaders(req), operationId: req.params.id, partKey: req.params.partKey }) })));
    }
    if (operations && transport) {
      // T12 — transferencias por capacidad (§8.6) y PROJECT por MASTER. Los bytes llegan como stream crudo (nunca JSON); el módulo drena
      // el cuerpo ante un rechazo temprano. Errores con detail.retry_after_ms llevan Retry-After.
      router.post(`${CATALOG_PREFIX}/operations/:id/parts/:partKey/capability`, handle(async (req, _res, userId) => ({ status: 201, body: await transport.issueUploadCapability({ userId, ...eraHeaders(req), operationId: req.params.id, partKey: req.params.partKey }) })));
      router.get(`${CATALOG_PREFIX}/operations/:id/attempts`, handle(async (req, _res, userId) => ({ body: await transport.listAttempts({ userId, operationId: req.params.id }) })));
      router.put(`${CATALOG_PREFIX}/transfer/upload/:token`, handle(async (req, _res, userId) => {
        const h = eraHeaders(req);
        return transport.uploadPart({ userId, ...h, token: req.params.token, stream: req, contentLength: req.get('content-length') || null });
      }));
      router.put(`${CATALOG_PREFIX}/operations/:id/parts/:partKey/project`, handle(async (req, _res, userId) => {
        const h = eraHeaders(req);
        const filename = req.get('x-catalog-filename');
        return transport.uploadProjectPart({ userId, ...h, operationId: req.params.id, partKey: req.params.partKey, stream: req, contentLength: req.get('content-length') || null, filename: typeof filename === 'string' && filename.length <= 512 ? filename : null });
      }));
    }
    router.post(`${CATALOG_PREFIX}/operations/:id/resume`, handle(async (req, _res, userId) => ({ body: await commands.resumeOperation({ userId, ...eraHeaders(req), operationId: req.params.id, revision: body(req).revision }) })));
    router.get(`${CATALOG_PREFIX}/changes`, handle(async (req, _res, userId) => ({ body: await commands.listChanges({ userId, query: req.query }) })));
  }
  if (playback) {
    // T14 — rondas Shuffle persistidas (r4 §5) y vecinos de orden (I2). El cliente nunca recibe la permutación ni los IDs del conjunto.
    router.post(`${CATALOG_PREFIX}/playback/rounds`, handle(async (req, _res, userId) => { const b = body(req); return { status: 201, body: await playback.startRound({ userId, ...eraHeaders(req), setId: b.setId, currentBeatId: b.currentBeatId ?? null, consumerId: b.consumerId, fromRoundId: b.fromRoundId ?? null }) }; }));
    router.get(`${CATALOG_PREFIX}/playback/rounds/:id`, handle(async (req, _res, userId) => ({ body: await playback.getRound({ userId, roundId: req.params.id }) })));
    router.post(`${CATALOG_PREFIX}/playback/rounds/:id/next`, handle(async (req, _res, userId) => { const b = body(req); return { body: await playback.nextInRound({ userId, ...eraHeaders(req), roundId: req.params.id, sequence: b.sequence, idempotencyKey: b.idempotencyKey ?? req.get('idempotency-key') }) }; }));
    router.post(`${CATALOG_PREFIX}/playback/rounds/:id/consume`, handle(async (req, _res, userId) => { const b = body(req); return { body: await playback.consumeInRound({ userId, ...eraHeaders(req), roundId: req.params.id, beatId: b.beatId, sequence: b.sequence, idempotencyKey: b.idempotencyKey ?? req.get('idempotency-key') }) }; }));
    router.post(`${CATALOG_PREFIX}/playback/rounds/:id/rebuild`, handle(async (req, _res, userId) => ({ body: await playback.rebuildRound({ userId, ...eraHeaders(req), roundId: req.params.id }) })));
    router.post(`${CATALOG_PREFIX}/playback/rounds/:id/release`, handle(async (req, _res, userId) => ({ body: await playback.releaseRound({ userId, ...eraHeaders(req), roundId: req.params.id }) })));
    router.get(`${CATALOG_PREFIX}/query-sets/:id/neighbor`, handle(async (req, _res, userId) => ({ body: await playback.neighbor({ userId, setId: req.params.id, beatId: typeof req.query.beatId === 'string' ? req.query.beatId : null, direction: req.query.direction, sort: typeof req.query.sort === 'string' ? req.query.sort : 'manual' }) })));
  }
  if (media) {
    // T14 — acceso a medios por referencia SQL (§8.6): concesión opaca por parte; bytes por HTTP con Range desde el gateway.
    router.post(`${CATALOG_PREFIX}/files/:fileId/access`, handle(async (req, _res, userId) => ({ status: 201, body: await media.issueAccess({ userId, fileId: req.params.fileId, epoch: req.get('x-catalog-epoch') || null }) })));
    const serve = async (req, res) => {
      const user = authenticate(req, res); if (!user) return;
      try { await media.stream({ userId: String(user.id), token: req.params.token, rangeHeader: req.get('range') || null, res, method: req.method }); } catch (error) {
        if (!(error instanceof CatalogAuthorityError) && !(error instanceof CatalogQueryError)) log('[catalog] media stream error', error?.message || error);
        if (!res.headersSent) { if (error && error.status === 416) res.setHeader('Content-Range', `bytes */${error.detail?.size ?? '*'}`); respondError(res, error); } else res.destroy();
      }
    };
    router.get(`${CATALOG_PREFIX}/media/:token`, serve);
    router.head(`${CATALOG_PREFIX}/media/:token`, serve);
  }
  // Rutas del contrato aún no implementadas (T15/T16): 501 explícito, nunca un éxito ficticio.
  router.use(CATALOG_PREFIX, (req, res) => res.status(501).json({ error: `${req.method} ${req.originalUrl.split('?')[0]} is not implemented yet`, code: 'NOT_IMPLEMENTED' }));
  return router;
}

module.exports = { CATALOG_PREFIX, API_LIMITS, createCatalogRouter, respondError };
