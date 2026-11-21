'use strict';
// LAB navegador: configuración compartida. Todo el estado efímero vive en tmp/catalog-lab/state (ignorado por git).
// Sin secretos versionados: el JSON de estado (credenciales aleatorias del LAB) se genera al arrancar y nunca se commitea.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const STATE_DIR = path.resolve(process.env.LAB_STATE_DIR || path.join(ROOT, 'tmp', 'catalog-lab', 'state'));
const PORTS = {
  pg: num(process.env.LAB_PG_PORT, 54339),
  cloud: num(process.env.LAB_CLOUD_PORT, 4140),
  webPostgres: num(process.env.LAB_WEB_PORT, 1440),
  webLegacy: num(process.env.LAB_WEB_LEGACY_PORT, 1441),
};
const PG_DIR = process.env.LAB_PG_DIR || '/tmp/bg-catlab-browser'; // ruta dentro de WSL
const WSL_DISTRO = process.env.LAB_WSL_DISTRO || 'Ubuntu';
const SEED_N = num(process.env.LAB_SEED_N, 300);
const DEFAULT_OUT = path.resolve(process.env.LAB_OUT_DIR || path.join(ROOT, 'tmp', 'catalog-lab-out'));

if ([5432, 54329].includes(PORTS.pg)) throw new Error(`LAB: puerto PG ${PORTS.pg} reservado (clúster de otros); usa uno propio`);

const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const statePath = (name) => path.join(STATE_DIR, name);

module.exports = { ROOT, STATE_DIR, PORTS, PG_DIR, WSL_DISTRO, SEED_N, DEFAULT_OUT, toWsl, statePath, CFG_FILE: statePath('lab.env.json') };
