#!/usr/bin/env node
'use strict';
// T17-N — Punto de entrada de la CLI nativa (NATIVO r2.1 §4). La conexión se pasa SIEMPRE con --database-url; DATABASE_URL y
// cualquier otra variable heredada se ignoran a propósito (CLAUDE.md §7: sin acceso implícito a bases heredadas).
const path = require('path');
const { createNativeCli, HELP } = require('../catalog/native-cli.js');

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(`${HELP}\n`);
    return argv.length ? 0 : 2;
  }
  const at = argv.indexOf('--database-url');
  if (at < 0 || !argv[at + 1] || String(argv[at + 1]).startsWith('--')) {
    process.stderr.write(JSON.stringify({ stop: 'STOP-ENV', code: 'DATABASE_URL_REQUIRED', message: 'pass --database-url <url> explicitly; inherited DATABASE_URL and environment variables are deliberately ignored', exit_code: 2 }) + '\n');
    return 2;
  }
  const url = String(argv[at + 1]);
  const rest = argv.filter((_, index) => index !== at && index !== at + 1);
  const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
  const pool = new Pool({ connectionString: url, max: 2, application_name: 'beatgaler-catalog-native-cli' });
  pool.on('error', () => {});
  const cli = createNativeCli({ pool });
  try {
    const out = await cli.run(rest);
    process.stdout.write(`${typeof out.result.help === 'string' ? out.result.help : JSON.stringify(out.result, null, 2)}\n`);
    return out.exitCode;
  } catch (error) {
    const described = cli.describeError(error);
    process.stderr.write(`${JSON.stringify(described)}\n`); // nunca incluye la URL
    return described.exit_code;
  } finally {
    await pool.end().catch(() => {});
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  process.stderr.write(`${JSON.stringify({ stop: 'ERROR', code: 'UNEXPECTED', message: String(error && error.message ? error.message : error), exit_code: 4 })}\n`);
  process.exit(4);
});
