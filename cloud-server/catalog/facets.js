'use strict';
// Facetas incrementales por delta (T20-N, STOP-PERF a 1M filas: el recuento completo por norm_key costaba O(tamaño del grupo)
// en cada mutación; ahora una mutación cuesta O(beats afectados × tags), sin escanear el grupo).
//
// Modelo (sin cambios): catalog_beat_tag_groups = una fila por (beat, norm_key, projection_version) con state/manual_rank
// denormalizados por FK ON UPDATE CASCADE (0026); catalog_facets = una fila por (scope ACTIVE|TRASH, norm_key, projection_version)
// con beat_count y el representante (menor manual_rank; empate -> beat_id COLLATE "C"). Convención de contador cero: la fila NO
// existe (el CHECK exige rep NULL con beat_count = 0 y queries.js lista solo beat_count > 0); igual que el recómputo completo.
//
// Protocolo de una mutación en línea:
//   1. before = snapshotGroups(beats afectados)            -- antes de tocar tags/estado
//   2. cambiar catalog_beats / catalog_beat_tags           -- trash/restore/purge NO reescriben grupos: state y manual_rank
//                                                             se propagan solos por la FK ON UPDATE CASCADE de 0026
//   3. si cambiaron tags: insertGroups(beats)              -- solo esos beats, nunca el grupo completo
//   4. after = snapshotGroups(beats afectados); applyFacetDelta(before, after)
// Concurrencia: TODOS los llamadores corren dentro de una transacción con `catalog_libraries ... FOR UPDATE` tomado por
// authority.requireLibraryForMutation (commands.mutationTx, operations.mutationTx, purge.mutationTx), así que las mutaciones de
// una biblioteca están serializadas y el contador leído-modificado-escrito no pierde actualizaciones. No hay red ni Telegram aquí.
// Fail-closed: si el contador resultara negativo, o un contador positivo no tuviera representante, la transacción aborta.
//
// El recómputo completo se conserva como ORÁCULO (facetsOracleDiff, solo lectura) y como RECONSTRUCCIÓN (rebuildFacets).

const SEP = '\u0000';

async function snapshotGroups(client, uid, gen, beatIds) {
  if (!beatIds || !beatIds.length) return [];
  const r = await client.query(`SELECT beat_id, norm_key, projection_version, state FROM catalog_beat_tag_groups
    WHERE user_id = $1 AND generation_id = $2 AND beat_id = ANY($3::text[]) AND state IN ('ACTIVE', 'TRASH')`, [uid, gen, beatIds]);
  return r.rows;
}

// Reescribe los grupos de ESTOS beats a partir de sus tags (solo cuando los tags cambiaron). No toca facetas.
async function insertGroups(client, uid, gen, beatIds) {
  if (!beatIds.length) return;
  await client.query('DELETE FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND beat_id = ANY($3::text[])', [uid, gen, beatIds]);
  await client.query(`INSERT INTO catalog_beat_tag_groups(user_id, generation_id, beat_id, norm_key, projection_version, state, manual_rank, first_position, label_at_first_position)
    SELECT DISTINCT ON (t.beat_id, t.norm_key) t.user_id, t.generation_id, t.beat_id, t.norm_key, t.projection_version, b.state, b.manual_rank, t.position, t.label
    FROM catalog_beat_tags t JOIN catalog_beats b USING (user_id, generation_id, beat_id)
    WHERE t.user_id = $1 AND t.generation_id = $2 AND t.beat_id = ANY($3::text[]) ORDER BY t.beat_id, t.norm_key, t.position`, [uid, gen, beatIds]);
}

// Aplica el delta entre dos snapshots: beat_count += Δ por (scope, norm_key, projection_version) y representante por sondeo top-1
// sobre catalog_beat_tag_groups_rep_idx (user_id, generation_id, state, norm_key, manual_rank, beat_id). Toda clave presente en
// cualquiera de los dos snapshots se re-sondea (el representante puede cambiar con Δ = 0: restore cambia manual_rank, un patch
// puede cambiar first_position/label).
async function applyFacetDelta(client, uid, gen, before, after, revision) {
  const deltas = new Map();
  const bump = (row, d) => {
    const k = `${row.state}${SEP}${row.norm_key}${SEP}${row.projection_version}`;
    let e = deltas.get(k);
    if (!e) { e = { scope: row.state, normKey: row.norm_key, pv: row.projection_version, delta: 0 }; deltas.set(k, e); }
    e.delta += d;
  };
  for (const r of before) bump(r, -1);
  for (const r of after) bump(r, +1);
  if (!deltas.size) return { touched: 0, upserted: 0, deleted: 0 };
  const list = [...deltas.values()];
  const scopes = list.map((e) => e.scope); const keys = list.map((e) => e.normKey); const pvs = list.map((e) => e.pv);
  const cur = (await client.query(`SELECT f.scope, f.norm_key, f.projection_version, f.beat_count::text AS n FROM catalog_facets f
    JOIN unnest($3::text[], $4::text[], $5::int[]) AS t(scope, norm_key, pv) ON f.scope = t.scope AND f.norm_key = t.norm_key AND f.projection_version = t.pv
    WHERE f.user_id = $1 AND f.generation_id = $2`, [uid, gen, scopes, keys, pvs])).rows;
  const old = new Map(cur.map((r) => [`${r.scope}${SEP}${r.norm_key}${SEP}${r.projection_version}`, Number(r.n)]));
  const delScopes = []; const delKeys = []; const delPvs = [];
  const upScopes = []; const upKeys = []; const upPvs = []; const upCnt = [];
  for (const e of list) {
    const next = (old.get(`${e.scope}${SEP}${e.normKey}${SEP}${e.pv}`) || 0) + e.delta;
    if (next < 0) throw Object.assign(new Error(`facet delta would make beat_count negative for ${e.scope}/${e.normKey}`), { code: 'FACET_DELTA_INCONSISTENT' });
    if (next === 0) { delScopes.push(e.scope); delKeys.push(e.normKey); delPvs.push(e.pv); } else { upScopes.push(e.scope); upKeys.push(e.normKey); upPvs.push(e.pv); upCnt.push(String(next)); }
  }
  let deleted = 0; let upserted = 0;
  if (delKeys.length) {
    deleted = (await client.query(`DELETE FROM catalog_facets f USING unnest($3::text[], $4::text[], $5::int[]) AS t(scope, norm_key, pv)
      WHERE f.user_id = $1 AND f.generation_id = $2 AND f.scope = t.scope AND f.norm_key = t.norm_key AND f.projection_version = t.pv`, [uid, gen, delScopes, delKeys, delPvs])).rowCount;
  }
  if (upKeys.length) {
    // LEFT JOIN: un contador positivo sin grupo daría rep NULL y violaría el CHECK (beat_count = 0) = (rep_beat_id IS NULL) -> aborta.
    upserted = (await client.query(`INSERT INTO catalog_facets(user_id, generation_id, scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label, updated_revision)
      SELECT $1, $2, t.scope, t.norm_key, t.pv, t.cnt, r.beat_id, r.first_position, r.label_at_first_position, $7::bigint
      FROM unnest($3::text[], $4::text[], $5::int[], $6::bigint[]) AS t(scope, norm_key, pv, cnt)
      LEFT JOIN LATERAL (
        SELECT g.beat_id, g.first_position, g.label_at_first_position FROM catalog_beat_tag_groups g
        WHERE g.user_id = $1 AND g.generation_id = $2 AND g.state = t.scope AND g.norm_key = t.norm_key AND g.projection_version = t.pv
          AND g.manual_rank = (SELECT m.manual_rank FROM catalog_beat_tag_groups m
                               WHERE m.user_id = $1 AND m.generation_id = $2 AND m.state = t.scope AND m.norm_key = t.norm_key AND m.projection_version = t.pv
                               ORDER BY m.manual_rank LIMIT 1)
        ORDER BY g.beat_id COLLATE "C" LIMIT 1) r ON true
      ON CONFLICT (user_id, generation_id, scope, norm_key, projection_version) DO UPDATE
        SET beat_count = EXCLUDED.beat_count, rep_beat_id = EXCLUDED.rep_beat_id, rep_position = EXCLUDED.rep_position, rep_label = EXCLUDED.rep_label, updated_revision = EXCLUDED.updated_revision
        WHERE (catalog_facets.beat_count, catalog_facets.rep_beat_id, catalog_facets.rep_position, catalog_facets.rep_label)
          IS DISTINCT FROM (EXCLUDED.beat_count, EXCLUDED.rep_beat_id, EXCLUDED.rep_position, EXCLUDED.rep_label)`, [uid, gen, upScopes, upKeys, upPvs, upCnt, revision])).rowCount;
  }
  return { touched: list.length, upserted, deleted };
}

const EXPECTED_FACETS_SQL = `SELECT state AS scope, norm_key, projection_version, count(*)::bigint AS beat_count,
    (array_agg(beat_id ORDER BY manual_rank, beat_id COLLATE "C"))[1] AS rep_beat_id,
    (array_agg(first_position ORDER BY manual_rank, beat_id COLLATE "C"))[1] AS rep_position,
    (array_agg(label_at_first_position ORDER BY manual_rank, beat_id COLLATE "C"))[1] AS rep_label
  FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND state IN ('ACTIVE', 'TRASH') GROUP BY state, norm_key, projection_version`;

// ORÁCULO (solo lectura): recómputo completo desde los grupos frente a catalog_facets. Devuelve las filas que difieren
// (comparación exacta de beat_count, rep_beat_id, rep_position, rep_label; updated_revision es metadato de última escritura).
async function facetsOracleDiff(client, uid, gen, { limit = 50 } = {}) {
  const r = await client.query(`WITH exp AS (${EXPECTED_FACETS_SQL}), cur AS (SELECT scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label FROM catalog_facets WHERE user_id = $1 AND generation_id = $2)
    SELECT coalesce(e.scope, c.scope) AS scope, coalesce(e.norm_key, c.norm_key) AS norm_key, coalesce(e.projection_version, c.projection_version) AS projection_version,
      e.beat_count::text AS expected_count, c.beat_count::text AS actual_count, e.rep_beat_id AS expected_rep, c.rep_beat_id AS actual_rep,
      e.rep_position AS expected_pos, c.rep_position AS actual_pos, e.rep_label AS expected_label, c.rep_label AS actual_label
    FROM exp e FULL OUTER JOIN cur c ON e.scope = c.scope AND e.norm_key = c.norm_key AND e.projection_version = c.projection_version
    WHERE (e.beat_count, e.rep_beat_id, e.rep_position, e.rep_label) IS DISTINCT FROM (c.beat_count, c.rep_beat_id, c.rep_position, c.rep_label)
      OR e.scope IS NULL OR c.scope IS NULL
    ORDER BY 1, 2, 3 LIMIT $3`, [uid, gen, limit]);
  const total = (await client.query(`WITH exp AS (${EXPECTED_FACETS_SQL}), cur AS (SELECT scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label FROM catalog_facets WHERE user_id = $1 AND generation_id = $2)
    SELECT count(*)::int AS n FROM exp e FULL OUTER JOIN cur c ON e.scope = c.scope AND e.norm_key = c.norm_key AND e.projection_version = c.projection_version
    WHERE (e.beat_count, e.rep_beat_id, e.rep_position, e.rep_label) IS DISTINCT FROM (c.beat_count, c.rep_beat_id, c.rep_position, c.rep_label) OR e.scope IS NULL OR c.scope IS NULL`, [uid, gen])).rows[0].n;
  return { differences: total, sample: r.rows };
}

// ORÁCULO de grupos (solo lectura): grupos esperados desde tags+beats frente a catalog_beat_tag_groups (incluye la propagación
// de state/manual_rank por la FK ON UPDATE CASCADE tras trash/restore). Cuenta filas distintas, faltantes y sobrantes.
async function groupsOracleDiff(client, uid, gen) {
  const r = await client.query(`WITH exp AS (
      SELECT DISTINCT ON (t.beat_id, t.norm_key) t.beat_id, t.norm_key, t.projection_version, b.state, b.manual_rank, t.position AS first_position, t.label AS label_at_first_position
      FROM catalog_beat_tags t JOIN catalog_beats b USING (user_id, generation_id, beat_id) WHERE t.user_id = $1 AND t.generation_id = $2 ORDER BY t.beat_id, t.norm_key, t.position),
    cur AS (SELECT beat_id, norm_key, projection_version, state, manual_rank, first_position, label_at_first_position FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2)
    SELECT count(*)::int AS n FROM exp e FULL OUTER JOIN cur c ON e.beat_id = c.beat_id AND e.norm_key = c.norm_key AND e.projection_version = c.projection_version
    WHERE (e.state, e.manual_rank, e.first_position, e.label_at_first_position) IS DISTINCT FROM (c.state, c.manual_rank, c.first_position, c.label_at_first_position) OR e.beat_id IS NULL OR c.beat_id IS NULL`, [uid, gen]);
  return { differences: r.rows[0].n };
}

// RECONSTRUCCIÓN: recómputo completo (borra y recuenta) para las claves dadas, o todas si normKeys es null. Mismo resultado que el
// camino incremental; costoso por diseño (O(tamaño de los grupos)): no usar en caminos de mutación en línea.
async function rebuildFacets(client, uid, gen, normKeys, revision) {
  const filter = normKeys ? ' AND norm_key = ANY($4::text[])' : '';
  const params = normKeys ? [uid, gen, revision, [...new Set(normKeys)]] : [uid, gen, revision];
  if (normKeys && !normKeys.length) return;
  await client.query(`DELETE FROM catalog_facets WHERE user_id = $1 AND generation_id = $2${normKeys ? ' AND norm_key = ANY($3::text[])' : ''}`, normKeys ? [uid, gen, [...new Set(normKeys)]] : [uid, gen]);
  await client.query(`WITH grp AS (SELECT * FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2${filter} AND state IN ('ACTIVE','TRASH')),
    cnt AS (SELECT state, norm_key, projection_version, count(*) AS n FROM grp GROUP BY 1, 2, 3),
    rep AS (SELECT DISTINCT ON (state, norm_key, projection_version) state, norm_key, projection_version, beat_id, first_position, label_at_first_position
            FROM grp ORDER BY state, norm_key, projection_version, manual_rank, beat_id COLLATE "C")
    INSERT INTO catalog_facets(user_id, generation_id, scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label, updated_revision)
    SELECT $1, $2, c.state, c.norm_key, c.projection_version, c.n, r.beat_id, r.first_position, r.label_at_first_position, $3::bigint
    FROM cnt c JOIN rep r USING (state, norm_key, projection_version)`, params);
}

module.exports = { snapshotGroups, insertGroups, applyFacetDelta, facetsOracleDiff, groupsOracleDiff, rebuildFacets };
