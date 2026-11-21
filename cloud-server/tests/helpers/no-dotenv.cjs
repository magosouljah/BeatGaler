'use strict';
// Precarga para procesos de prueba (scripts/run-cloud-tests.mjs): `dotenv` nunca lee archivos .env.
// Motivo: algunos módulos importados por tests cargan `cloud-server/.env` por ruta explícita al evaluarse
// (p. ej. scripts/auth-identity-preflight.cjs); en un checkout de desarrollo ese archivo contiene credenciales reales.
// Ningún test necesita dotenv: su entorno lo construye el runner por allowlist.
const path = require('path');

const roots = [path.join(__dirname, '..', '..'), path.join(__dirname, '..', '..', '..')];
for (const base of roots) {
  let resolved;
  try { resolved = require.resolve('dotenv', { paths: [base] }); } catch { continue; }
  const dotenv = require(resolved);
  const inert = () => ({ parsed: {} });
  dotenv.config = inert;
  if (typeof dotenv.configDotenv === 'function') dotenv.configDotenv = inert;
  if (typeof dotenv._configVault === 'function') dotenv._configVault = inert;
}
