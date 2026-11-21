'use strict';
// Archivos locales ignorados por git que contienen credenciales o estado real de un checkout de desarrollo. Varios módulos del
// Cloud los leen o escriben por RUTA FIJA junto al código (direct-transport-control.js y master-storage.js con master-session.txt,
// vault-registry.json, …), así que ninguna variable de entorno los aísla. Los runners de pruebas se niegan a ejecutarse si existen.
// Solo se comprueba la existencia por nombre: nunca se leen.
const fs = require('fs');
const path = require('path');

const LOCAL_SECRET_FILES = Object.freeze(['master-session.txt', 'transport-bots.local.json', 'masters.local.json', 'vault-registry.json', 'accounts-data.json', 'cloud-data.json']);

function findLocalSecretFiles(repoRoot) {
  const dir = path.join(repoRoot, 'cloud-server');
  const found = LOCAL_SECRET_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* sin cloud-server */ }
  for (const f of entries) if (/^\.env(\..+)?$/.test(f) && f !== '.env.example') found.push(f);
  if (fs.existsSync(path.join(repoRoot, '.env'))) found.push('../.env');
  return found;
}

const REFUSAL_HELP = [
  'Ejecuta las pruebas desde un worktree limpio, donde esos archivos no existen:',
  '  git worktree add --detach ../BeatGaler-test HEAD',
  '  (enlazar node_modules y cloud-server/node_modules con junctions; quitarlas con `rmdir` antes de borrar el worktree)',
].join('\n');

module.exports = { LOCAL_SECRET_FILES, findLocalSecretFiles, REFUSAL_HELP };
