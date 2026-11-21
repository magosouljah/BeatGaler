#!/usr/bin/env node
'use strict';
// Oráculo de facetas (T20-N): compara catalog_facets con el recómputo completo desde catalog_beat_tag_groups y los grupos con
// catalog_beat_tags + catalog_beats (state/manual_rank propagados por la FK ON UPDATE CASCADE). Solo lectura.
// Uso como módulo:   const { runOracle } = require('./facets-oracle.cjs'); await runOracle(pool, { userId })
// Uso como script:   node scripts/catalog-bench/facets-oracle.cjs --url postgresql://usuario@127.0.0.1:54330/bench1m [--user-id bench-u1] [--sample 20]
// Salida: JSON { facetDifferences, groupDifferences, sample } y exit 0 solo si ambas son 0. Pensado para correr tras la campaña de 1M
// (tarda de segundos a decenas de segundos: agrega ~3,5 M filas de grupos). No escribe nada.
const path = require('path');
const facets = require(path.join(__dirname, '..', '..', 'cloud-server', 'catalog', 'facets.js'));

async function runOracle(poolOrClient, { userId, generationId = null, sample = 20 } = {}) {
  if (!userId) throw new Error('runOracle: userId requerido');
  let gen = generationId;
  if (!gen) {
    const r = await poolOrClient.query('SELECT active_generation_id FROM catalog_libraries WHERE user_id = $1', [userId]);
    if (!r.rows.length) throw new Error(`runOracle: sin biblioteca para ${userId}`);
    gen = r.rows[0].active_generation_id;
  }
  const t0 = process.hrtime.bigint();
  const f = await facets.facetsOracleDiff(poolOrClient, userId, gen, { limit: sample });
  const g = await facets.groupsOracleDiff(poolOrClient, userId, gen);
  const facetRows = (await poolOrClient.query('SELECT count(*)::int AS n FROM catalog_facets WHERE user_id = $1 AND generation_id = $2', [userId, gen])).rows[0].n;
  return { userId, generationId: gen, facetRows, facetDifferences: f.differences, groupDifferences: g.differences, sample: f.sample, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const url = get('--url', null);
  if (!url) { process.stderr.write('uso: facets-oracle.cjs --url <postgresql://...> [--user-id bench-u1] [--sample 20]\n'); process.exit(2); }
  const { Client } = require(path.join(__dirname, '..', '..', 'cloud-server', 'node_modules', 'pg'));
  (async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const res = await runOracle(c, { userId: get('--user-id', 'bench-u1'), sample: Number(get('--sample', '20')) });
      await c.query('COMMIT');
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exitCode = res.facetDifferences === 0 && res.groupDifferences === 0 ? 0 : 1;
    } finally { await c.end().catch(() => {}); }
  })().catch((e) => { process.stderr.write(`facets-oracle: ${e.message}\n`); process.exitCode = 3; });
}
module.exports = { runOracle };
