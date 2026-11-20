'use strict';
// Directorio de ESTADO persistente del Cloud (sesiones, vínculos de instalación, snapshots JSON de compatibilidad,
// estado de ciclo de vida). Debe vivir FUERA del directorio de la release: cada release es código inmutable y el estado
// sobrevive a despliegues y rollbacks. Sin BEATGALER_STATE_DIR se conserva el comportamiento histórico (junto al código)
// para LOCAL y tests; en producción `assertProductionStateDir` (arranque de server.js / worker) lo exige.
const fs = require('node:fs');
const path = require('node:path');

const CODE_DIR = __dirname;
const isProduction = (env) => ['production', 'prod'].includes(String(env.BEATGALER_DEPLOYMENT_ENV || env.NODE_ENV || '').trim().toLowerCase());

function resolveStateDir(env = process.env) {
  const raw = String(env.BEATGALER_STATE_DIR || '').trim();
  return raw ? path.resolve(raw) : CODE_DIR;
}

function assertProductionStateDir(env = process.env, dir = resolveStateDir(env)) {
  if (!isProduction(env)) return dir;
  if (!String(env.BEATGALER_STATE_DIR || '').trim()) throw new Error('STOP: BEATGALER_STATE_DIR is required in production (state must live outside the release directory).');
  let st; try { st = fs.statSync(dir); } catch { throw new Error('STOP: BEATGALER_STATE_DIR does not exist.'); }
  if (!st.isDirectory()) throw new Error('STOP: BEATGALER_STATE_DIR is not a directory.');
  const release = path.resolve(CODE_DIR, '..');
  const rel = path.relative(release, dir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('STOP: BEATGALER_STATE_DIR must be outside the release directory in production.');
  return dir;
}

const STATE_DIR = resolveStateDir();
const statePath = (name) => path.join(STATE_DIR, name);

module.exports = { STATE_DIR, statePath, resolveStateDir, assertProductionStateDir, CODE_DIR };
