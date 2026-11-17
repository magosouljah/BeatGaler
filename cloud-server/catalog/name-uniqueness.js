'use strict';
// Unicidad de nombres de beats ACTIVOS por biblioteca (paridad con el sistema anterior: `name.trim().toLowerCase()` entre los beats de la biblioteca).
// Normalización = la del contrato existente (`legacy-codec.projectBeat().nameSearch`: trim + toLowerCase; vacío → «untitled»).
// Concurrencia: toda mutación (PATCH, restore, commit de IMPORT/REPLACE) toma `catalog_libraries FOR UPDATE` antes de llamar aquí, así que la
// comprobación + la escritura son atómicas por biblioteca: dos operaciones simultáneas con el mismo nombre se serializan y la segunda recibe NAME_TAKEN (409).
// Solo cuentan beats ACTIVE (papelera/purga no reservan nombre). No toca datos existentes: duplicados históricos no bloquean ediciones que no cambian el nombre.
const { CatalogQueryError } = require('./cursor');

const nameKey = (name) => (typeof name === 'string' ? name : 'Untitled').trim().toLowerCase() || 'untitled';

async function findNameOwner(client, uid, gen, name, exceptBeatId = null) {
  const r = await client.query(
    "SELECT beat_id FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE' AND name_search = $3 AND ($4::text IS NULL OR beat_id <> $4) ORDER BY beat_id COLLATE \"C\" LIMIT 1",
    [uid, gen, nameKey(name), exceptBeatId]);
  return r.rows[0] ? r.rows[0].beat_id : null;
}

async function assertNameFree(client, uid, gen, name, exceptBeatId = null) {
  const owner = await findNameOwner(client, uid, gen, name, exceptBeatId);
  if (owner) throw new CatalogQueryError('NAME_TAKEN', 409, 'a beat with this name already exists', { name: String(name).trim(), beatId: owner });
}

module.exports = { nameKey, findNameOwner, assertNameFree };
