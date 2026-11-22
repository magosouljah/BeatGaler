'use strict';

const { prepareControlPlaneCutover } = require('./control-plane-cutover-runtime');
const accessRuntime = require('./access-runtime');
const catalogAuthority = require('./catalog/authority');
const catalogQueries = require('./catalog/queries');
const catalogCommands = require('./catalog/commands');
const catalogOperations = require('./catalog/operations');
const catalogPurge = require('./catalog/purge');
const { createFileDeletionJournal } = require('./catalog-deletion-journal');
const catalogGateway = require('./catalog-gateway-runtime');

async function resolveCatalogAccess(userId) {
  const access = await accessRuntime.resolveUserAccess({ id: userId });
  const max = access && access.quotas ? access.quotas.max_beats : null;
  return { maxBeats: max === undefined ? null : max };
}

function configureCatalogServices(config, env) {
  const queries = catalogQueries.configureCatalogQueries(config ? { ...config, env } : null);
  const commands = catalogCommands.configureCatalogCommands(config);
  // T09: la cuota usa Access (quotas.max_beats; null = sin límite).
  const operations = catalogOperations.configureCatalogOperations(config ? { ...config, resolveAccess: resolveCatalogAccess } : null);
  return { queries, commands, operations };
}

function configurePurge(config, gateway, journalDir) {
  // C9: el journal externo es obligatorio para cualquier borrado físico.
  return catalogPurge.configureCatalogPurge(config ? {
    ...config,
    gateway,
    journal: journalDir ? createFileDeletionJournal({ dir: journalDir }) : null,
  } : null);
}

async function assembleServerCatalog({ pool, env, cutover, onGatewayConfigured }) {
  const catalogPlayback = require('./catalog/playback');
  const catalogMedia = require('./catalog/media');
  const catalogDirect = require('./catalog/direct');
  const catalogNativeTransport = require('./catalog/native-transport-provisioning');
  const catalogPrefixPacks = require('./catalog/prefix-packs');

  // T05-N: la autoridad solo se monta con el plano PostgreSQL.
  const nativeAuthority = catalogAuthority.configureCatalogAuthority(cutover.authority === 'postgres' && pool
    ? { pool, env, controlPlaneAuthority: cutover.authority } : null);
  const config = nativeAuthority ? { pool, authority: nativeAuthority } : null;
  const { queries: nativeQueries } = configureCatalogServices(config, env);

  // Owner-authorized reduced-fencing rollout: distinct from a G2 PASS.
  const reusedBotRiskAccepted = String(env.BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED || '').trim().toLowerCase() === 'true';
  if (reusedBotRiskAccepted) {
    if (!pool || !nativeAuthority || !nativeAuthority.config.nativeEnabled) {
      throw new Error('STOP-GATE: reused bot risk acceptance requires an enabled native PostgreSQL authority');
    }
    const activation = (await pool.query('SELECT transport_bot_ids, direct_token_exposure FROM catalog_native_activation')).rows;
    if (activation.length !== 1 || activation[0].direct_token_exposure !== 'REUSED_UNROTATED') {
      throw new Error('STOP-GATE: reused bot risk acceptance requires REUSED_UNROTATED SQL activation');
    }
    console.warn('[catalog] OWNER_RISK_ACCEPTED: unrotated Telegram tokens reused; G2 NOT_PROVEN; E8 residual risk');
  }

  // T16: sin gateway de medios, transferencias 503 y jobs en reintento.
  const gatewayRuntime = catalogGateway.gatewayFromEnv({ pool: nativeAuthority ? pool : null, env, log: console });
  // El cierre PostgreSQL debe conocer el gateway aun si falla una configuración posterior.
  onGatewayConfigured(gatewayRuntime);
  const mediaGateway = gatewayRuntime ? gatewayRuntime.gateway : null;
  const nativeOperations = catalogOperations.currentCatalogOperations();
  catalogPlayback.configureCatalogPlayback(nativeAuthority ? { pool, authority: nativeAuthority } : null);
  const directFlag = String(env.BEATGALER_CATALOG_DIRECT_ENABLED || '').trim().toLowerCase() === 'true';
  catalogMedia.configureCatalogMedia(nativeAuthority ? { pool, authority: nativeAuthority } : null);
  const journalDir = String(env.BEATGALER_CATALOG_JOURNAL_DIR || '').trim();
  configurePurge(config, mediaGateway, journalDir);

  // Direct B (E70): apagado por defecto. En producción exige el dictamen G2 o riesgo aceptado.
  const directProd = ['production', 'prod'].includes(String(env.BEATGALER_DEPLOYMENT_ENV || env.NODE_ENV || '').trim().toLowerCase());
  if (directFlag && directProd && String(env.BEATGALER_CATALOG_G2_APPROVED || '').trim().toLowerCase() !== 'true' && !reusedBotRiskAccepted) {
    throw new Error('STOP-GATE: BEATGALER_CATALOG_DIRECT_ENABLED=true in production requires proven G2 or owner-accepted unrotated-bot risk; refusing to start.');
  }
  // E75: el gateway solo comprueba el mensaje publicado por el navegador.
  catalogPrefixPacks.configurePrefixPacks(String(env.BEATGALER_CATALOG_PREFIX_PACKS_ENABLED || '').trim().toLowerCase() === 'true' && nativeAuthority ? {
    pool, authority: nativeAuthority, gateway: mediaGateway, directReads: directFlag, log: console.warn,
  } : null);
  catalogDirect.configureCatalogDirect(directFlag && nativeAuthority && nativeOperations ? {
    pool, authority: nativeAuthority, operations: nativeOperations,
    resolveProjectAccess: catalogDirect.createProjectAccessResolver({ resolveUserAccess: (u) => accessRuntime.resolveUserAccess(u) }),
    sessionSource: ({ botId, chatId }) => require('./direct-transport-control').catalogDirectSession({ botId, chatId }),
    bindBuilder: (session, metadata) => require('./productive-temp-auth-boundary').transformSession(session, metadata),
    log: console.warn,
  } : null);
  // La pertenencia al vault se verifica de forma perezosa con MASTER y el bot.
  catalogNativeTransport.configureNativeTransportProvisioner(
    nativeAuthority?.config.nativeEnabled && directFlag && mediaGateway
      ? { pool, assignmentStore: require('./direct-vault-assignment').createDirectVaultAssignmentStore(pool), transport: require('./direct-transport-control'), log: console.warn }
      : null);

  // E73: precalentamiento en segundo plano, sin bloquear el arranque ni /readyz.
  const direct = catalogDirect.currentCatalogDirect();
  const raw = env.BEATGALER_CATALOG_DIRECT_PREWARM_BOTS;
  const maxBots = raw === undefined || raw === '' ? 3 : Number(raw);
  if (direct && maxBots > 0) {
    const timer = setTimeout(() => { direct.prewarm({ maxBots }).catch(() => {}); }, 3000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  console.log(`[catalog] native=${nativeAuthority ? (nativeAuthority.config.nativeEnabled ? 'enabled' : 'flag-off') : 'not-mounted'} cursor-keys=${nativeQueries ? nativeQueries.keySource : 'n/a'} gateway=${mediaGateway ? 'bot-router(lazy)' : 'none'} journal=${journalDir ? 'file' : 'none'}`);
}

async function assembleWorkerCatalog({ pool, env }) {
  const cutover = await prepareControlPlaneCutover({ pool, env });
  if (cutover.authority !== 'postgres') {
    console.error('[catalog-worker] refused: control-plane authority is not postgres');
    await pool.end();
    return null;
  }
  const authority = catalogAuthority.configureCatalogAuthority({ pool, env, controlPlaneAuthority: cutover.authority });
  if (!authority || !authority.config.nativeEnabled) {
    console.error('[catalog-worker] refused: native catalog flag is off');
    await pool.end();
    return null;
  }
  await authority.availability();
  accessRuntime.configure({ pool });
  const config = { pool, authority };
  const { queries, commands, operations } = configureCatalogServices(config, env);
  const gatewayRuntime = catalogGateway.gatewayFromEnv({ pool, env, log: console });
  const mediaGateway = gatewayRuntime ? gatewayRuntime.gateway : null;
  const journalDir = String(env.BEATGALER_CATALOG_JOURNAL_DIR || '').trim();
  const purge = configurePurge(config, mediaGateway, journalDir);
  const { createCatalogWorker } = require('./catalog/worker');
  const worker = createCatalogWorker({
    pool, operations, queries, commands, transport: mediaGateway, purge,
    log: (...args) => console.warn(...args),
    options: { pollMs: Number(env.BEATGALER_CATALOG_WORKER_POLL_MS || 1000) },
  });
  return { worker, gatewayRuntime, mediaGateway };
}

module.exports = { prepareControlPlaneCutover, assembleServerCatalog, assembleWorkerCatalog };
