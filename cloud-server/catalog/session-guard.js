'use strict';
// T16 — Capa 2 del cerco (NATIVO r2.1 §5.1, C10 fila `session/start`): con el flag nativo encendido, un dueño con fila de catálogo solo
// puede abrir sesión declarando el protocolo `catalog-v1`; cualquier otro protocolo (o ninguno) se rechaza con 410 antes de tocar
// Direct, Telegram o SQL legacy. La respuesta para `catalog-v1` lleva era/época (y nunca credenciales: §8.5, T05-N).
// Con el flag apagado la capa 2 no actúa (interruptor no destructivo): la capa 1 sigue cercando las entradas C10 legacy.
// Solo SQL + helpers internos. Sin transporte.

const { CatalogLegacyFenceError } = require('./legacy-fence');
const { CATALOG_SESSION_PROTOCOL } = require('./authority');

const LIB_SQL = 'SELECT authority, authority_era::text AS era, authority_epoch::text AS epoch, migration_state FROM catalog_libraries WHERE user_id = $1 /* catalog-session-guard */';

// Regla pura (también la usan las pruebas): decide sin SQL a partir de los hechos.
function evaluateSessionProtocol({ hasCatalog = false, nativeEnabled = false, protocol = null } = {}) {
  const declared = String(protocol || '').trim();
  if (!hasCatalog) return { outcome: 'LEGACY', catalog: false };
  if (!nativeEnabled) return { outcome: 'FLAG_OFF', catalog: true }; // capa 2 inactiva: la capa 1 decide en cada entrada C10
  if (declared === CATALOG_SESSION_PROTOCOL) return { outcome: 'CATALOG', catalog: true };
  return { outcome: 'REJECT', catalog: true, required: CATALOG_SESSION_PROTOCOL, declared: declared || null };
}

function createCatalogSessionGuard({ pool = null, authority = null } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createCatalogSessionGuard requires a PostgreSQL pool');
  const nativeEnabled = () => Boolean(authority && authority.config && authority.config.nativeEnabled);
  async function libraryOf(userId) {
    const uid = String(userId ?? '').trim(); if (!uid) return null;
    const r = await pool.query(LIB_SQL, [uid]);
    return r.rows[0] || null;
  }
  /** Lanza CatalogLegacyFenceError (410) cuando un dueño nativo intenta `session/start` sin `catalog-v1` con el flag encendido. */
  async function assertProtocol({ userId, protocol = null, entry = 'session/start' } = {}) {
    const lib = await libraryOf(userId);
    const v = evaluateSessionProtocol({ hasCatalog: Boolean(lib), nativeEnabled: nativeEnabled(), protocol });
    if (v.outcome === 'REJECT') throw new CatalogLegacyFenceError(`${entry} requires protocol ${CATALOG_SESSION_PROTOCOL} for a PostgreSQL catalog library.`, { entry, by: 'protocol', required: CATALOG_SESSION_PROTOCOL, declared: v.declared });
    if (!lib) return { catalog: false, outcome: v.outcome };
    return { catalog: true, outcome: v.outcome, protocol: v.outcome === 'CATALOG' ? CATALOG_SESSION_PROTOCOL : null, authority: lib.authority, authority_era: lib.era, authority_epoch: lib.epoch, migration_state: lib.migration_state };
  }
  return Object.freeze({ assertProtocol, evaluate: evaluateSessionProtocol, nativeEnabled });
}

let configured = null;
function configureCatalogSessionGuard(options = null) { configured = options && options.pool ? createCatalogSessionGuard(options) : null; return configured; }
function currentCatalogSessionGuard() { return configured; }
// Sin guard configurado (control-plane json / sin PG) no hay catálogo que proteger: la sesión legacy sigue como hoy.
async function assertCatalogSessionProtocolIfConfigured(input) { if (!configured) return { catalog: false, outcome: 'UNCONFIGURED' }; return configured.assertProtocol(input); }

module.exports = { evaluateSessionProtocol, createCatalogSessionGuard, configureCatalogSessionGuard, currentCatalogSessionGuard, assertCatalogSessionProtocolIfConfigured };
