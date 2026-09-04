'use strict';

const fs = require('fs');
const path = require('path');

const MAX_STARTUP_BEATS = 14;
const ROUTING_FILE = 'startup-routing-index.json';

function positiveMessageId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function normalizeBeatId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 256 ? id : '';
}

function normalizeStartupBeatIds(value) {
  const output = [];
  const seen = new Set();
  for (const candidate of Array.isArray(value) ? value : []) {
    const id = normalizeBeatId(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
    if (output.length >= MAX_STARTUP_BEATS) break;
  }
  return output;
}

function normalizeRoutingChanges(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  let count = 0;
  for (const [rawBeatId, rawMessageId] of Object.entries(source)) {
    const beatId = normalizeBeatId(rawBeatId);
    if (!beatId) continue;
    if (rawMessageId === null) output[beatId] = null;
    else {
      const messageId = positiveMessageId(rawMessageId);
      if (!messageId) continue;
      output[beatId] = messageId;
    }
    count += 1;
    if (count >= 10000) break;
  }
  return output;
}

function messageIdFromDirectLocator(value) {
  const match = /^direct:(\d+)$/.exec(String(value || '').trim());
  return positiveMessageId(match?.[1]);
}

function masterMessageIdFromEntry(value) {
  const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const master = entry?.master && typeof entry.master === 'object' && !Array.isArray(entry.master) ? entry.master : null;
  const manifest = master?.manifest && typeof master.manifest === 'object' && !Array.isArray(master.manifest) ? master.manifest : null;
  const parts = Array.isArray(manifest?.parts) ? manifest.parts : Array.isArray(master?.parts) ? master.parts : [];
  const first = parts[0] && typeof parts[0] === 'object' && !Array.isArray(parts[0]) ? parts[0] : null;
  return positiveMessageId(first?.telegram_message_id)
    || messageIdFromDirectLocator(first?.telegram_file_id)
    || positiveMessageId(master?.telegram_message_id)
    || messageIdFromDirectLocator(master?.telegram_file_id)
    || messageIdFromDirectLocator(master?.cloud_file_id);
}

function routingSnapshotFromManifest(manifest) {
  const root = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  if (!root || !Array.isArray(root.beats)) return {};
  const output = {};
  for (const value of root.beats) {
    const beatId = normalizeBeatId(value?.id);
    if (!beatId) continue;
    const messageId = masterMessageIdFromEntry(value);
    if (messageId) output[beatId] = messageId;
  }
  return output;
}

function linkedVaultId(dataDir, installationId) {
  const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'cloud-data.json'), 'utf8'));
  const account = parsed?.linkedAccounts?.[String(installationId)] || null;
  const vault = String(account?.storageChatId || '').trim();
  if (!vault) throw new Error('BeatGaler private storage is not provisioned for this account.');
  return vault;
}

function authorizedInstallation(req) {
  const requested = String(req?.body?.beatgalerUserId || '').trim();
  const authorized = String(req?.beatgalerAuthorizedInstallationId || '').trim();
  return requested && authorized && requested === authorized ? requested : '';
}

function createFileRoutingStore(dataDir) {
  const filePath = path.join(dataDir, ROUTING_FILE);
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.vaults && typeof parsed.vaults === 'object' ? parsed : { version: 1, vaults: {} };
    } catch {
      return { version: 1, vaults: {} };
    }
  };
  const write = data => {
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), 'utf8');
    fs.renameSync(temp, filePath);
  };
  const vaultState = (data, vaultId) => {
    const current = data.vaults[vaultId];
    if (current && typeof current === 'object' && current.routes && typeof current.routes === 'object') return current;
    const created = { revision: 0, routes: {} };
    data.vaults[vaultId] = created;
    return created;
  };
  return {
    async getRoutes(vaultId, beatIds) {
      const data = read();
      const state = vaultState(data, vaultId);
      const routes = {};
      for (const beatId of beatIds) {
        const messageId = positiveMessageId(state.routes[beatId]);
        if (messageId) routes[beatId] = messageId;
      }
      return { revision: Math.max(0, Number(state.revision) || 0), routes };
    },
    async applyChanges(vaultId, rawChanges) {
      const changes = normalizeRoutingChanges(rawChanges);
      const data = read();
      const state = vaultState(data, vaultId);
      let changed = false;
      for (const [beatId, messageId] of Object.entries(changes)) {
        if (messageId === null) {
          if (Object.prototype.hasOwnProperty.call(state.routes, beatId)) {
            delete state.routes[beatId];
            changed = true;
          }
        } else if (positiveMessageId(state.routes[beatId]) !== messageId) {
          state.routes[beatId] = messageId;
          changed = true;
        }
      }
      if (changed) {
        state.revision = Math.max(0, Number(state.revision) || 0) + 1;
        write(data);
      }
      return { revision: Math.max(0, Number(state.revision) || 0), changed };
    },
    async replace(vaultId, rawSnapshot) {
      const snapshot = normalizeRoutingChanges(rawSnapshot);
      const nextRoutes = {};
      for (const [beatId, messageId] of Object.entries(snapshot)) if (messageId !== null) nextRoutes[beatId] = messageId;
      const data = read();
      const state = vaultState(data, vaultId);
      const changed = JSON.stringify(state.routes) !== JSON.stringify(nextRoutes);
      if (changed) {
        state.routes = nextRoutes;
        state.revision = Math.max(0, Number(state.revision) || 0) + 1;
        write(data);
      }
      return { revision: Math.max(0, Number(state.revision) || 0), changed };
    },
  };
}

function createPostgresRoutingStore(pool) {
  let schemaPromise = null;
  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS beatgaler_startup_routing_revisions (vault_id TEXT PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS beatgaler_startup_routes (vault_id TEXT NOT NULL, beat_id TEXT NOT NULL, master_message_id BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (vault_id, beat_id))`);
      })().catch(error => { schemaPromise = null; throw error; });
    }
    return schemaPromise;
  };
  const lockVault = (client, vaultId) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`beatgaler:startup-routing:${vaultId}`]);
  const readRevision = async (client, vaultId) => {
    const result = await client.query('SELECT revision FROM beatgaler_startup_routing_revisions WHERE vault_id = $1', [vaultId]);
    return Math.max(0, Number(result.rows?.[0]?.revision) || 0);
  };
  const bumpRevision = async (client, vaultId, current) => {
    const next = current + 1;
    await client.query(`INSERT INTO beatgaler_startup_routing_revisions (vault_id, revision, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (vault_id) DO UPDATE SET revision = EXCLUDED.revision, updated_at = NOW()`, [vaultId, next]);
    return next;
  };
  return {
    async getRoutes(vaultId, beatIds) {
      await ensureSchema();
      const [routeRows, revRows] = await Promise.all([
        beatIds.length > 0 ? pool.query('SELECT beat_id, master_message_id FROM beatgaler_startup_routes WHERE vault_id = $1 AND beat_id = ANY($2::text[])', [vaultId, beatIds]) : Promise.resolve({ rows: [] }),
        pool.query('SELECT revision FROM beatgaler_startup_routing_revisions WHERE vault_id = $1', [vaultId]),
      ]);
      const routes = {};
      for (const row of routeRows.rows || []) {
        const beatId = normalizeBeatId(row.beat_id);
        const messageId = positiveMessageId(row.master_message_id);
        if (beatId && messageId) routes[beatId] = messageId;
      }
      return { revision: Math.max(0, Number(revRows.rows?.[0]?.revision) || 0), routes };
    },
    async applyChanges(vaultId, rawChanges) {
      await ensureSchema();
      const entries = Object.entries(normalizeRoutingChanges(rawChanges));
      if (entries.length === 0) {
        const result = await pool.query('SELECT revision FROM beatgaler_startup_routing_revisions WHERE vault_id = $1', [vaultId]);
        return { revision: Math.max(0, Number(result.rows?.[0]?.revision) || 0), changed: false };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockVault(client, vaultId);
        let changed = false;
        for (const [beatId, messageId] of entries) {
          if (messageId === null) {
            const result = await client.query('DELETE FROM beatgaler_startup_routes WHERE vault_id = $1 AND beat_id = $2', [vaultId, beatId]);
            changed = changed || result.rowCount > 0;
            continue;
          }
          const current = await client.query('SELECT master_message_id FROM beatgaler_startup_routes WHERE vault_id = $1 AND beat_id = $2', [vaultId, beatId]);
          if (positiveMessageId(current.rows?.[0]?.master_message_id) === messageId) continue;
          await client.query(`INSERT INTO beatgaler_startup_routes (vault_id, beat_id, master_message_id, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (vault_id, beat_id) DO UPDATE SET master_message_id = EXCLUDED.master_message_id, updated_at = NOW()`, [vaultId, beatId, messageId]);
          changed = true;
        }
        const before = await readRevision(client, vaultId);
        const revision = changed ? await bumpRevision(client, vaultId, before) : before;
        await client.query('COMMIT');
        return { revision, changed };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async replace(vaultId, rawSnapshot) {
      await ensureSchema();
      const nextEntries = Object.entries(normalizeRoutingChanges(rawSnapshot)).filter(([, messageId]) => messageId !== null);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockVault(client, vaultId);
        const currentRows = await client.query('SELECT beat_id, master_message_id FROM beatgaler_startup_routes WHERE vault_id = $1 ORDER BY beat_id', [vaultId]);
        const current = Object.fromEntries((currentRows.rows || []).map(row => [row.beat_id, positiveMessageId(row.master_message_id)]));
        const desired = Object.fromEntries(nextEntries);
        const changed = JSON.stringify(current) !== JSON.stringify(desired);
        let revision = await readRevision(client, vaultId);
        if (changed) {
          await client.query('DELETE FROM beatgaler_startup_routes WHERE vault_id = $1', [vaultId]);
          for (const [beatId, messageId] of nextEntries) await client.query('INSERT INTO beatgaler_startup_routes (vault_id, beat_id, master_message_id, updated_at) VALUES ($1, $2, $3, NOW())', [vaultId, beatId, messageId]);
          revision = await bumpRevision(client, vaultId, revision);
        }
        await client.query('COMMIT');
        return { revision, changed };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function createStartupRoutingStore({ pool, dataDir }) {
  return pool ? createPostgresRoutingStore(pool) : createFileRoutingStore(dataDir);
}

function installStartupRoutingIndex(express, { pool, dataDir = __dirname } = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerStartupRoutingPatchInstalled) return;
  application.__beatgalerStartupRoutingPatchInstalled = true;
  const previousPost = application.post;
  const store = createStartupRoutingStore({ pool, dataDir });

  const installReconcileRoute = app => {
    if (app.__beatgalerStartupRoutingRouteInstalled) return;
    app.__beatgalerStartupRoutingRouteInstalled = true;
    previousPost.call(app, '/transport/routing/reconcile', async (req, res) => {
      const installationId = authorizedInstallation(req);
      if (!installationId) return res.status(403).json({ error: 'Startup routing reconcile requires the authenticated installation.' });
      try {
        const vaultId = linkedVaultId(dataDir, installationId);
        const snapshot = req.body?.routingSnapshot && typeof req.body.routingSnapshot === 'object' ? req.body.routingSnapshot : routingSnapshotFromManifest(req.body?.manifest);
        const result = await store.replace(vaultId, snapshot);
        return res.json({ ok: true, routing_revision: result.revision, changed: result.changed });
      } catch (error) {
        console.error('[routing] authoritative reconcile failed:', error?.message || error);
        return res.status(503).json({ error: 'Startup routing reconcile could not be persisted.' });
      }
    });
  };

  application.post = function startupRoutingPatchedPost(routePath, ...handlers) {
    installReconcileRoute(this);
    if (routePath === '/transport/session/start') {
      const prepareRouting = (req, _res, next) => {
        const beatIds = normalizeStartupBeatIds(req.body?.startupBeatIds);
        req.beatgalerStartupBeatIds = beatIds;
        const installationId = authorizedInstallation(req);
        if (!installationId || beatIds.length === 0) {
          req.beatgalerStartupRoutingPromise = Promise.resolve({ revision: 0, routes: {} });
          return next();
        }
        try {
          const vaultId = linkedVaultId(dataDir, installationId);
          req.beatgalerStartupRoutingPromise = store.getRoutes(vaultId, beatIds).catch(error => {
            console.warn('[routing] startup lookup failed; continuing without routes:', error?.message || error);
            return { revision: 0, routes: {} };
          });
        } catch (error) {
          console.warn('[routing] startup vault lookup failed; continuing without routes:', error?.message || error);
          req.beatgalerStartupRoutingPromise = Promise.resolve({ revision: 0, routes: {} });
        }
        return next();
      };
      const attachRouting = (req, res, next) => {
        const originalJson = res.json.bind(res);
        let sent = false;
        res.json = payload => {
          if (sent) return res;
          sent = true;
          const status = Number(res.statusCode || 200);
          void (async () => {
            let output = payload;
            if (status < 400 && payload && typeof payload === 'object') {
              const routing = await (req.beatgalerStartupRoutingPromise || Promise.resolve({ revision: 0, routes: {} }));
              output = { ...payload, startup_beat_ids: req.beatgalerStartupBeatIds || [], startup_routes: routing.routes || {}, routing_revision: Math.max(0, Number(routing.revision) || 0) };
            }
            originalJson(output);
          })().catch(error => {
            console.warn('[routing] startup response decoration failed:', error?.message || error);
            originalJson(payload);
          });
          return res;
        };
        return next();
      };
      return previousPost.call(this, routePath, prepareRouting, attachRouting, ...handlers);
    }

    if (routePath === '/transport/index/commit') {
      const attachCommit = (req, res, next) => {
        const originalJson = res.json.bind(res);
        let sent = false;
        res.json = payload => {
          if (sent) return res;
          sent = true;
          const status = Number(res.statusCode || 200);
          void (async () => {
            let output = payload;
            if (status < 400 && payload && typeof payload === 'object') {
              const installationId = authorizedInstallation(req);
              const changes = normalizeRoutingChanges(req.body?.routingChanges);
              if (installationId && Object.keys(changes).length > 0) {
                try {
                  const vaultId = linkedVaultId(dataDir, installationId);
                  const result = await store.applyChanges(vaultId, changes);
                  output = { ...payload, routing_revision: result.revision };
                } catch (error) {
                  console.warn('[routing] index commit routing update failed; authoritative index remains valid:', error?.message || error);
                }
              }
            }
            originalJson(output);
          })().catch(error => {
            console.warn('[routing] index commit response decoration failed:', error?.message || error);
            originalJson(payload);
          });
          return res;
        };
        return next();
      };
      return previousPost.call(this, routePath, attachCommit, ...handlers);
    }

    return previousPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  MAX_STARTUP_BEATS,
  positiveMessageId,
  normalizeStartupBeatIds,
  normalizeRoutingChanges,
  routingSnapshotFromManifest,
  authorizedInstallation,
  createStartupRoutingStore,
  installStartupRoutingIndex,
};
