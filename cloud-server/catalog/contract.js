'use strict';
// T03 — Contrato del catálogo PostgreSQL: valores cerrados y validación de identidad de tenant/generación.
// Espejo de CHECKs de 0026_catalog_core.sql; la DB sigue siendo la autoridad de las restricciones.

const AUTHORITY = Object.freeze(['LEGACY', 'POSTGRES']);
const MIGRATION_STATES = Object.freeze(['IDLE', 'SHADOW', 'FREEZING', 'FROZEN', 'ROLLBACK', 'REVIEW']);
const GENERATION_STATUS = Object.freeze(['STAGING', 'VALIDATED', 'ACTIVE', 'RETIRED']);
const GENERATION_TRANSITIONS = Object.freeze({ STAGING: ['VALIDATED', 'RETIRED'], VALIDATED: ['ACTIVE', 'RETIRED'], ACTIVE: ['RETIRED'], RETIRED: [] });
const BEAT_STATES = Object.freeze(['ACTIVE', 'TRASH', 'PURGING', 'PURGED']);
const FILE_ROLES = Object.freeze(['MASTER', 'WAV', 'ARTWORK', 'PROJECT', 'SAMPLES', 'STEMS', 'LOOP', 'LEGACY_OTHER', 'METADATA']);
const FILE_STATUS = Object.freeze(['STAGED', 'VERIFIED', 'RETIRED', 'DELETING', 'DELETED', 'REVIEW']);
const QUERY_SET_STATUS = Object.freeze(['BUILDING', 'READY', 'STALE', 'FAILED', 'CANCELLED', 'RELEASED']);
const LEGACY_SCOPES = Object.freeze(['root', 'garbage', 'deleted', 'trash_wrapper', 'topic_map']);
const DIRECT_SCOPE_ID_RE = /^[A-Za-z0-9._:@+-]{1,192}$/;
const GENERATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class CatalogContractError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

function requireUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 256) throw new CatalogContractError('CATALOG_TENANT_REQUIRED', 'userId requerido');
  return userId;
}
function requireGenerationId(generationId) {
  if (typeof generationId !== 'string' || !GENERATION_ID_RE.test(generationId)) throw new CatalogContractError('CATALOG_GENERATION_REQUIRED', 'generationId requerido');
  return generationId;
}
function requireScope(scope) {
  if (!scope || typeof scope !== 'object') throw new CatalogContractError('CATALOG_TENANT_REQUIRED', 'scope {userId, generationId} requerido');
  return Object.freeze({ userId: requireUserId(scope.userId), generationId: requireGenerationId(scope.generationId) });
}

// Longitud como la mide JS (UTF-16) y como la mide PostgreSQL (code points): ambas en 1..256 (D-06).
function beatIdIssues(id) {
  const issues = [];
  if (typeof id !== 'string') return ['NOT_STRING'];
  const codePoints = [...id].length;
  if (id.length < 1 || id.length > 256) issues.push('UTF16_LENGTH');
  if (codePoints < 1 || codePoints > 256) issues.push('CODEPOINT_LENGTH');
  if (id !== id.trim()) issues.push('EDGE_WHITESPACE');
  if (/\u0000/.test(id)) issues.push('NUL');
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(id)) issues.push('LONE_SURROGATE');
  return issues;
}

module.exports = {
  AUTHORITY, MIGRATION_STATES, GENERATION_STATUS, GENERATION_TRANSITIONS, BEAT_STATES, FILE_ROLES, FILE_STATUS,
  QUERY_SET_STATUS, LEGACY_SCOPES, DIRECT_SCOPE_ID_RE, GENERATION_ID_RE,
  CatalogContractError, requireUserId, requireGenerationId, requireScope, beatIdIssues,
};
