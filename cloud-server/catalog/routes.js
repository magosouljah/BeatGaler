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
// Todo error se responde como JSON {error, code, detail}; nunca 200 vacío ante error (C5).
// Cualquier entrada con cerco legacy (410 LEGACY_CLIENT_UNSUPPORTED) no pasa por aquí: estas rutas son solo nativas.

const express = require('express');
const { CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');

const CATALOG_PREFIX = '/catalog/v1';
const API_LIMITS = Object.freeze({ listDefault: 100, listMax: 240, filesMax: 100, facetsMax: 240, batchMax: 50, bodyMetadataBytes: 64 * 1024, bodyBatchBytes: 256 * 1024, pageBytes: 2 * 1024 * 1024, legacyOffsetMax: 10000 });

function respondError(res, error) {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError) {
    return res.status(error.status).json({ error: error.message, code: error.code, detail: error.detail || {} });
  }
  if (error && error.code === 'CATALOG_TENANT_REQUIRED') return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'UNAUTHENTICATED' });
  // Error inesperado: nunca 200 ni lista vacía; 500 con mensaje opaco.
  return res.status(500).json({ error: 'catalog request failed', code: 'CATALOG_INTERNAL_ERROR' });
}

function createCatalogRouter({ authority = null, queries = null, authenticate, log = () => {} } = {}) {
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
  // Rutas del contrato aún no implementadas (T07/T09/T10/T14): 501 explícito, nunca un éxito ficticio.
  router.use(CATALOG_PREFIX, (req, res) => res.status(501).json({ error: `${req.method} ${req.originalUrl.split('?')[0]} is not implemented yet`, code: 'NOT_IMPLEMENTED' }));
  return router;
}

module.exports = { CATALOG_PREFIX, API_LIMITS, createCatalogRouter, respondError };
