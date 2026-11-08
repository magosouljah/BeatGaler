#!/usr/bin/env node
'use strict';
// T01 / V01-A — Generador determinista de fixtures sintéticos del INDEX.
// Sin red, sin DB, sin .env. IDs y nombres sintéticos. Uso:
//   node cloud-server/tests/fixtures/catalog/generate-fixtures.cjs [--check]
// --check regenera en memoria y compara con manifest.json (exit 1 si difiere).
// Los "raw" se escriben como texto literal: algunos fixtures son JSON inválido
// o contienen claves duplicadas/escapes a propósito y NO deben normalizarse.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const GENERATOR_VERSION = 2;
// v2 (T01-C FX-01): schema real del INDEX en todos los fixtures de INDEX; oracles/expected sin cambios.
// Lectores: library-beat-quota.js:28, server-core.js:2561, webLibrary.ts:11, versioning.rs:6 (también para v1).
const SCHEMA = 'beatgaler.telegram.library';
const SEED = 777;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const J = (v) => JSON.stringify(v, null, 2) + '\n';

// PRNG determinista (mulberry32) para datasets grandes / oráculos.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ref = (m) => ({ telegram_file_id: `direct:${m}`, telegram_message_id: m });
const beat = (id, extra = {}) => ({ id, sort_order: 0, name: `Beat ${id}`, bpm: '120', key: 'C', tags: [], rating: 0, ...extra });

const fixtures = [];
// kind: index-valid | index-review | index-invalid-json | index-raw-review (parsea pero pierde info) | window | external-state | oracle-input
// expected: "actual" (comportamiento HEAD a4462191 observado) | "candidato-r4" | "review"
function add(id, kind, expected, oracle, content, note) {
  fixtures.push({ id, file: `${id}.json`, kind, expected, oracle, content, note });
}
const root = (beats, extra = {}) => ({ schema: SCHEMA, version: 2, updated_at: 1762560000, beats, trash: [], ...extra });

// ---- T01 paso 4 (originales) ----
add('t01-empty-certified', 'index-valid', 'actual', 'roundtrip idéntico; 0 beats; biblioteca vacía certificada (distinto de puntero ausente)', J(root([])));
add('t01-beat-minimal', 'index-valid', 'actual', 'roundtrip idéntico; campos ausentes siguen ausentes', J(root([{ id: 'b-min', sort_order: 0, name: 'Min' }])));
add('t01-all-slots', 'index-valid', 'actual', 'todos los slots conocidos; cada referencia física inventariada (master, artwork, metadata, files, project parts)', J(root([beat('b-all', {
  color: '#ff0055', color2: '#00ffaa', telegram_topic_id: 9001, metadata_message_id: 501,
  master: { ...ref(502), filename: 'm.wav', mime: 'audio/wav', size: 1000 },
  artwork: { ...ref(503), hash: 'a'.repeat(64), mime: 'image/png', filename: 'a.png', size: 10 },
  files: [{ cloud_file_id: 'f1', type: 'stems', filename: 's.zip', size: 5, status: 'ready', ...ref(504) },
    { cloud_file_id: 'f2', type: 'mp3', filename: 'x.mp3', size: 4, status: 'ready', ...ref(505) }],
  project: { manifest: { filename: 'p.zip', original_size: 30, transport: 'direct', parts: [{ index: 0, size: 15, filename: 'p.000', ...ref(506) }, { index: 1, size: 15, filename: 'p.001', ...ref(507) }] }, size: 30, openable: true, has_flp: true, has_als: false, has_samples: true },
})])));
add('t01-null-vs-absent', 'index-valid', 'actual', 'null y ausente se conservan distintos en raw; DTO actual los colapsa (pérdida documentada, no importador)', J(root([
  { id: 'b-null', sort_order: 0, name: null, bpm: null, key: null, tags: null, artwork: null, master: null },
  { id: 'b-absent', sort_order: 1 },
  { id: 'b-art-nullfields', sort_order: 2, name: 'Desktop sin artwork', artwork: { telegram_file_id: null, telegram_message_id: null, hash: null } },
])), 'b-art-nullfields: codificación Desktop de "sin artwork"; purge actual la rechaza (STOP-DATA D-04)');
add('t01-unicode-tags', 'index-valid', 'actual', 'tags repetidos/case/espacios preservados en raw; Web rename usa Set exacto, Desktop trim+lowercase', J(root([
  beat('b-u1', { name: 'Árbol', tags: ['Trap', 'trap', ' Trap ', 'Trap', 'Ñandú', '🌙'] }),
  beat('b-u2', { name: 'a\u0301rbol', sort_order: 1, tags: ['TRAP', 'Lo-fi', 'lo‑fi'] }),
  beat('b-u3', { name: 'ß', sort_order: 2, tags: [1, true, null, 'ss'] }),
])), 'tags no string: DTO actual los descarta; importador debe conservarlos raw');
add('t01-id-256', 'index-review', 'review', 'id 256 chars válido en INDEX/SQL CHECK; >192 rechazado por capability scope; 257 inválido', J(root([
  beat('i'.repeat(256)), beat('j'.repeat(192), { sort_order: 1 }), beat('k'.repeat(193), { sort_order: 2 }), beat('l'.repeat(257), { sort_order: 3 }),
])));
add('t01-id-collisions', 'index-review', 'review', 'REVIEW: " a"/"a" y 1/"1" colisionan tras trim/String (library-beat-quota.js:17-18); IDs duplicados', J(root([
  beat('a'), beat(' a', { sort_order: 1 }), beat(1, { sort_order: 2 }), beat('1', { sort_order: 3 }), beat('dup', { sort_order: 4 }), beat('dup', { sort_order: 5, name: 'otro' }),
])));
add('t01-metadata-message-id', 'index-valid', 'actual', 'metadata_message_id es referencia física (retención/purge)', J(root([beat('b-meta', { metadata_message_id: 777001, master: ref(777002) })])));
add('t01-multipart', 'index-valid', 'actual', 'legacy multipart en master/files/project preservado; DTO actual toma solo parte 0 (pérdida)', J(root([beat('b-mp', {
  master: { filename: 'big.wav', manifest: { filename: 'big.wav', original_size: 6e7, transport: 'direct', parts: [0, 1, 2].map((i) => ({ index: i, size: 2e7, filename: `big.${i}`, ...ref(600 + i) })) } },
  files: [{ cloud_file_id: 'f-mp', type: 'stems', filename: 's.zip', manifest: { parts: [{ index: 0, ...ref(610) }, { index: 1, ...ref(611) }] } },
    { cloud_file_id: 'f-legacy', type: 'stems', filename: 's2.zip', parts: [{ index: 0, ...ref(612) }] }],
})])), 'files[*].parts top-level (legacy) vs files[*].manifest.parts: el colector vivo server-core.js:2632 solo lee el primero (STOP-DATA D-05)');
add('t01-repeated-unknown-files', 'index-valid', 'actual', 'tipos repetidos y desconocidos preservados; DTO actual toma el primero por tipo', J(root([beat('b-files', {
  files: [{ cloud_file_id: 'a', type: 'mp3', ...ref(701) }, { cloud_file_id: 'b', type: 'mp3', ...ref(702) }, { cloud_file_id: 'c', type: 'hologram', ...ref(703), x_future: { k: 1 } }],
})])));
add('t01-trash-deleted-garbage', 'index-valid', 'actual', 'wrapper trash, deleted[] (beat_id/deleted_at y alias id/at OPAQUE), garbage[] (marked_at ISO vs epoch)', J(root([beat('b-live')], {
  trash: [{ trash_id: 't1', trashed_at: 1762000000, purge_after: 1764592000, beat: beat('b-trashed', { master: ref(801) }) }, { trash_id: 't2', beat: beat('b-trash-noTs'), x_wrapper_ext: 1 }],
  deleted: [{ beat_id: 'b-gone', deleted_at: 1761000000 }, { id: 'b-gone-alias', at: 1761000001 }, { beat_id: 'b-gone-nots' }],
  garbage: [{ message_id: 9901, reason: 'replaced', marked_at: '2026-11-01T00:00:00Z' }],
})), 'trash sin wrapper (beat suelto) se cubre en t01-trash-unwrapped');
add('t01-trash-unwrapped', 'index-review', 'review', 'beat suelto en trash: Rust/Web lo aceptan, servidor (library-beat-quota.js:39) lo rechaza', J(root([], { trash: [beat('b-loose')] })));
add('t01-shared-reference', 'index-review', 'review', 'misma referencia física en beat activo y en trash: purge no debe borrarla', J(root([beat('b-a', { master: ref(900) })], { trash: [{ trash_id: 't-s', trashed_at: 1, beat: beat('b-b', { master: ref(900) }) }] })));
add('t01-unknown-fields', 'index-valid', 'actual', 'campos desconocidos en root/beat/wrapper se conservan', J(root([beat('b-x', { x_ext: { nested: [1, { a: null }] } })], { x_root_ext: 'keep' })));
add('t01-v1-implicit', 'index-valid', 'actual', 'v1 (version ausente): source-roundtrip exacto; authoritative-export v2 añade version:2 y trash:[] como delta listado', J({ schema: SCHEMA, beats: [{ id: 'b-v1', name: 'Old', sort_order: 0 }] }));
add('t01-version-null', 'index-review', 'review', 'version:null → Rust as_i64 None→1, Web null??1→1, commands.rs:1805 lee 0; REVIEW', J({ schema: SCHEMA, version: null, beats: [] }));
add('t01-version-future', 'index-review', 'review', 'version 3 → rechazo explícito (no soportada)', J({ schema: SCHEMA, version: 3, beats: [] }));
add('t01-source-order-ne-sort', 'index-valid', 'actual', 'orden del array ≠ sort_order: preservar ambos; export regenera contiguo solo tras cambios (delta permitido C4)', J(root([beat('b3', { sort_order: 2 }), beat('b1', { sort_order: 0 }), beat('b2', { sort_order: 0 })])));
add('t01-pointer-absent-nonempty', 'index-review', 'review', 'descriptor: biblioteca con beats en SQL/quota pero sin puntero de INDEX → REVIEW, nunca vacío certificado', J({ descriptor: { pin_message_id: null, sql_pointer: null, library_beats_count: 3 }, index: null }));
add('t01-tombstone-sql-only', 'index-valid', 'candidato-r4', 'tombstone en library_trash_purges sin entrada en INDEX: aparece solo en authoritative-export como delta; sin timestamp → null, no fecha actual', J({ index: root([beat('b-keep')]), sql_tombstones: [{ beat_id: 'b-purged', state: 'CONFIRMED', confirmed_at: 1762000000 }, { beat_id: 'b-legacy', state: 'LEGACY_TOMBSTONE', confirmed_at: null }] }));
// Raw no-JSON-limpio: se escriben literalmente.
add('t01-invalid-json', 'index-invalid-json', 'review', 'JSON inválido → REVIEW (no reparar)', '{"schema":"beatgaler.telegram.library","version":2,"beats":[{"id":"b1",}]\n');
add('t01-duplicate-keys', 'index-raw-review', 'review', 'claves duplicadas → REVIEW (JSON.parse se queda con la última: pérdida silenciosa)', '{"schema":"beatgaler.telegram.library","version":2,"beats":[{"id":"b1","name":"A","name":"B"}],"version":2}\n');
add('t01-unsafe-int', 'index-raw-review', 'review', 'entero no seguro en message_id → REVIEW', '{"schema":"beatgaler.telegram.library","version":2,"beats":[{"id":"b1","master":{"telegram_message_id":9007199254740993}}]}\n');
add('t01-nul-surrogates', 'index-raw-review', 'review', 'NUL y surrogates sueltos: JSON.parse acepta, PG jsonb/text rechaza NUL → conservar bytes raw (bytea) + REVIEW', '{"schema":"beatgaler.telegram.library","version":2,"beats":[{"id":"b-nul","name":"a\\u0000b"},{"id":"b-sur","name":"x\\ud800y"},{"id":"b-sur2","name":"\\udfff"}]}\n');
add('t01-beathash-key-order', 'index-review', 'review', 'mismo beat, distinto orden de claves → beatHash (sha256(JSON.stringify)) distinto; reserializar rompe PENDING purges (STOP-DATA D-03)', J({ a: { id: 'b-h', name: 'N', bpm: '1' }, b: { name: 'N', id: 'b-h', bpm: '1' } }));
add('t01-size-zero', 'index-review', 'review', 'size 0: ¿desconocido o vacío? (commands.rs unwrap_or(0)) → preservar raw, no inferir', J(root([beat('b-z', { master: { ...ref(950), size: 0 } })])));
add('t01-botapi-file-id', 'index-review', 'review', 'telegram_file_id histórico sin forma direct: → OPAQUE; bloquea operaciones que lo interpreten (purge)', J(root([beat('b-bot', { master: { telegram_file_id: 'AgACAgEAAxkBAAI-synthetic', telegram_message_id: 960 } })])));
// ---- T01-C FX-02: reglas T01-B sin fixture (contract-map stops[*].t01b.regla) ----
add('t01-garbage-intersects-live', 'index-review', 'review', 'D-02: garbage[] con message_id que coincide con referencia viva (1100 master activo) y de trash anidada (1102 parte de project) => REVIEW; 1199 sin referencia se preserva verbatim y por sí solo no es REVIEW (ver 9901 en t01-trash-deleted-garbage). El catálogo no borra nada por estar en garbage[]', J(root([beat('b-g1', { master: ref(1100) })], {
  trash: [{ trash_id: 't-g', trashed_at: 1762000000, beat: beat('b-g2', { master: ref(1101), project: { manifest: { filename: 'p.zip', parts: [{ index: 0, ...ref(1102) }] } } }) }],
  garbage: [{ message_id: 1100, reason: 'replaced', marked_at: 1762000000 }, { message_id: 1102, reason: 'replaced', marked_at: '2026-11-01T00:00:00Z' }, { message_id: 1199, reason: 'replaced', marked_at: 1762000001 }],
})), 'colector completo recursivo (master/artwork/project/files, manifest.parts y parts top-level, metadata_message_id), no collectManifestMediaMessageIds (D-05)');
add('t01-topic-map-mismatch', 'index-review', 'review', 'D-09: beatTopics de cloud-data.json (clave topicKey instalación:beat, server-core.js:189) con enlace instalación→users.id verificado; b-t1 coincide (solo evidencia, catalog_legacy_fields scope=topic_map), b-t2 mapa 9555 != beat.telegram_topic_id 9002 => REVIEW. Ningún topic se borra', J({
  index: root([beat('b-t1', { telegram_topic_id: 9001 }), beat('b-t2', { sort_order: 1, telegram_topic_id: 9002 })]),
  link: { installation_id: 'inst-A', user_id: 'u-1', verified_against_vaults: true },
  cloud_data: { beatTopics: { 'inst-A:b-t1': { chatId: -1001234, messageThreadId: 9001, beatName: 'Beat b-t1', updatedAt: 1762000000000 }, 'inst-A:b-t2': { chatId: -1001234, messageThreadId: 9555, beatName: 'Beat b-t2', updatedAt: 1762000000000 } } },
}));
add('t01-topic-map-link-ambiguous', 'index-review', 'review', 'D-09: entradas beatTopics cuya instalación enlaza a dos users.id (ambiguo) o a otro usuario => REVIEW; cloud-data.json nunca es fuente de tenant', J({
  index: root([beat('b-t1', { telegram_topic_id: 9001 })]),
  links: [{ installation_id: 'inst-A', user_id: 'u-1', verified_against_vaults: true }, { installation_id: 'inst-A', user_id: 'u-2', verified_against_vaults: true }, { installation_id: 'inst-B', user_id: 'u-2', verified_against_vaults: true }],
  importing_user: 'u-1',
  cloud_data: { beatTopics: { 'inst-A:b-t1': { chatId: -1001234, messageThreadId: 9001 }, 'inst-B:b-t1': { chatId: -1009999, messageThreadId: 9001 } } },
}));
add('t01-id-trim-unpaired', 'index-review', 'review', 'D-06: id !== id.trim() => REVIEW aunque no exista la pareja recortada (" solo", "tail ", "\\t tab"); nunca recortar', J(root([beat(' solo'), beat('tail ', { sort_order: 1 }), beat('\t tab', { sort_order: 2 }), beat('ok', { sort_order: 3 })])), 'ok es control válido');
add('t01-id-astral', 'index-review', 'review', 'D-06: astral 😀×128 = 256 UTF-16 / 128 chars PG => válido con direct_scope_compatible=false; 😀×129 = 258 UTF-16 => REVIEW; "a"×255+😀 = 257 UTF-16 / 256 chars PG => REVIEW (ambas métricas deben estar en 1..256)', J(root([beat('😀'.repeat(128)), beat('😀'.repeat(129), { sort_order: 1 }), beat('a'.repeat(255) + '😀', { sort_order: 2 })])));
add('t01-trash-beat-nonobject', 'index-review', 'review', 'D-07: item de trash con clave beat cuyo valor no es objeto (string, null, array, número) => REVIEW; distinto de fila desnuda sin clave beat (t01-trash-unwrapped)', J(root([], {
  trash: [{ trash_id: 't-s', trashed_at: 1, beat: 'b-str' }, { trash_id: 't-n', trashed_at: 1, beat: null }, { trash_id: 't-a', trashed_at: 1, beat: ['b-arr'] }, { trash_id: 't-num', trashed_at: 1, beat: 7 }],
})));
add('t01-deleted-alias-conflict', 'index-review', 'review', 'catalog_tombstones T01-B: deleted[] con beat_id e id distintos => REVIEW; ambos ausentes => REVIEW; beat_id e id iguales => no REVIEW (raw_key verbatim)', J(root([], {
  deleted: [{ beat_id: 'b-d1', id: 'b-d2', deleted_at: 1761000000 }, { deleted_at: 1761000001 }, { beat_id: 'b-d3', id: 'b-d3', deleted_at: 1761000002 }],
})), 'b-d3 es control no-REVIEW');
add('t01-live-vs-tombstone', 'index-review', 'review', 'D-10/C1.11: beat vivo con mismo ID que tombstone SQL (CONFIRMED) o que deleted[] del INDEX => REVIEW; nunca resucitar ni descartar el tombstone', J({
  index: root([beat('b-x'), beat('b-y', { sort_order: 1 })], { deleted: [{ beat_id: 'b-y', deleted_at: 1761000000 }] }),
  sql_tombstones: [{ beat_id: 'b-x', state: 'CONFIRMED', confirmed_at: 1762000000 }],
}));
add('t01-manifest-toplevel-ref', 'index-review', 'review', 'C4 (referencias inconsistentes => REVIEW): master.manifest.telegram_file_id/telegram_message_id (direct:1600) distinta de todas sus parts (direct:1601); los escritores reales (webTransport.worker.ts:3291, project-upload-route.js:71, commands.rs:2141) emiten la referencia de manifest igual a parts[0], como files/project de este mismo fixture (1602, 1603). Sintético: no corregir, no importar; MANIFEST_REF_UNREPRESENTED en master. Decisión aprobada 2026-11-08', J(root([beat('b-mt', {
  master: { filename: 'm.wav', manifest: { telegram_file_id: 'direct:1600', telegram_message_id: 1600, filename: 'm.wav', original_size: 9, transport: 'direct-web', parts: [{ index: 0, size: 9, filename: 'm.wav', ...ref(1601) }] } },
  files: [{ cloud_file_id: 'f-mt', type: 'stems', filename: 's.zip', manifest: { telegram_file_id: 'direct:1602', telegram_message_id: 1602, parts: [{ index: 0, ...ref(1602) }] } }],
  project: { size: 5, manifest: { telegram_file_id: 'direct:1603', telegram_message_id: 1603, filename: 'p.zip', original_size: 5, transport: 'direct-web', parts: [{ index: 0, size: 5, filename: 'p.zip', ...ref(1603) }] } },
})])));
add('t01-uploaded-files-beat-mismatch', 'index-review', 'review', 'COV-01/C4 (CONTRATO:99 referencias inconsistentes): uploadedFiles de cloud-data.json (server-core.js:2379/2934) no es autoridad ni se importa; solo se coteja. direct:1400 en INDEX bajo b-u1 y en uploadedFiles bajo b-u2 => REVIEW. direct:1401 coincide (no-op). direct:1402 sin referencia en INDEX = upload huérfano: fuga, no pérdida, no REVIEW, nunca se barre (D-01/D-02)', J({
  index: root([beat('b-u1', { master: ref(1400) }), beat('b-u2', { sort_order: 1, master: ref(1401) })]),
  link: { installation_id: 'inst-A', user_id: 'u-1', verified_against_vaults: true },
  cloud_data: { uploadedFiles: {
    'direct:1400': { beatgalerUserId: 'inst-A', telegramMessageId: 1400, filename: 'm.wav', kind: 'MASTER', beatId: 'b-u2', createdAt: 1762000000000 },
    'direct:1401': { beatgalerUserId: 'inst-A', telegramMessageId: 1401, filename: 'm.wav', kind: 'MASTER', beatId: 'b-u2', createdAt: 1762000000000 },
    'direct:1402': { beatgalerUserId: 'inst-A', telegramMessageId: 1402, filename: 'old.wav', kind: 'MASTER', beatId: 'b-u1', createdAt: 1761000000000 },
  } },
}), 'kind no se compara con el slot (sin contrato kind↔slot): se registra verbatim');
add('t01-message-redirect-stale', 'index-review', 'review', 'COV-01/C4: messageRedirects (server-core.js:475, migración legacy a topics) con clave instalación:oldId cuyo oldId 1500 sigue referenciado en el INDEX => REVIEW; el catálogo nunca aplica redirects en silencio. Redirect 1510→1511 sin referencia en INDEX: sin efecto', J({
  index: root([beat('b-r1', { master: ref(1500) })]),
  link: { installation_id: 'inst-A', user_id: 'u-1', verified_against_vaults: true },
  cloud_data: { messageRedirects: { 'inst-A:1500': 1501, 'inst-A:1510': 1511 } },
}));
add('t01-nul-unprojected', 'index-valid', 'candidato-r4', 'D-08: NUL y surrogate suelto solo en campos NO proyectados (beat.x_ext, clave anidada, wrapper de trash, extra de root, extra de garbage) => biblioteca elegible; legacy_json y catalog_legacy_fields guardan TEXT con los escapes ASCII (\\u0000, \\ud800) sin byte NUL ni pérdida; nunca jsonb (si una columna legacy fuese jsonb => REVIEW, nunca strip); raw_index bytea exacto; proyecciones no afectadas. Contraste: t01-nul-surrogates (campos proyectados => REVIEW)', J(root([beat('b-nul-x', { x_ext: 'a\u0000b', x_nested: { 'k\u0000': ['\ud800'] } })], {
  trash: [{ trash_id: 't-nul', trashed_at: 1762000000, x_wrapper_ext: 'w\u0000', beat: beat('b-nul-t', { x_sur: 'z\udfff' }) }],
  garbage: [{ message_id: 1300, reason: 'replaced', marked_at: 1762000000, x_g: 'g\u0000' }],
  x_root_nul: 'r\u0000',
})), 'el archivo es ASCII en esos valores: JSON.stringify escapa U+0000 y surrogates sueltos (ES2019 well-formed)');
{
  // Bytes por encima del presupuesto reversible (15 MiB) sin superar 16 MiB.
  const pad = 'x'.repeat(1024);
  const n = Math.ceil((15 * 1024 * 1024) / 1040) + 64;
  const beats = [];
  for (let i = 0; i < n; i++) beats.push({ id: `b${String(i).padStart(6, '0')}`, sort_order: i, name: pad });
  const s = JSON.stringify(root(beats)) + '\n';
  add('t01-over-rollback-budget', 'index-review', 'review', `ON-DEMAND (no se versiona; regenerar con --big). UTF-8 bytes > 15 MiB (rollback_max_bytes) y < 16 MiB: biblioteca fuera del piloto reversible (ROLLBACK_CAPACITY_EXCEEDED); bytes=${Buffer.byteLength(s)}`, s);
}

// ---- C12 casos ----
add('c12-u01-names', 'oracle-input', 'actual', 'U01: 20 nombres anexo + Z,10,2,-,_,🌙,ß,ss + ausente/null/vacío + duplicados. Oráculo actual (Node22/Chrome152 es-MX) para b0..b19: 9,8,2,3,4,5,1,10,13,12,11,17,14,15,16,7,6,18,19,0. Candidato ICU und: lo fija T06 (no inventado aquí)', J(root([
  ...['z', 'ä', 'a', 'A', 'á', 'a\u0301', 'ñ', 'n', '😀', '🎵', 'a-2', 'a2', 'a10', 'a.2', 'I', 'İ', 'ı', 'i', 'same', 'same'].map((name, i) => ({ id: `b${i}`, sort_order: i, name, rating: 0 })),
  ...['Z', '10', '2', '-', '_', '🌙', 'ß', 'ss'].map((name, i) => ({ id: `x${i}`, sort_order: 20 + i, name, rating: 0 })),
  { id: 'n-absent', sort_order: 28 }, { id: 'n-null', sort_order: 29, name: null }, { id: 'n-empty', sort_order: 30, name: '' },
  { id: 'b0', sort_order: 31, name: 'dup-id' },
])), 'b0 duplicado a propósito → REVIEW de identidad');
add('c12-u02-nfc-nfd', 'oracle-input', 'candidato-r4', 'U02: NFC/NFD en ambos órdenes manuales; T06 verifica 4 sorts × limit 1/2/240 sin saltos/duplicados', J({ orderA: root([{ id: 'nfc', sort_order: 0, name: '\u00e1' }, { id: 'nfd', sort_order: 1, name: 'a\u0301' }]), orderB: root([{ id: 'nfd', sort_order: 0, name: 'a\u0301' }, { id: 'nfc', sort_order: 1, name: '\u00e1' }]) }));
add('c12-n01-bpm', 'oracle-input', 'candidato-r4', 'N01/A2: raw preservado; clase −Inf, finitos, +Inf, NaN/no numérico al final; sin NaN en JSON. Oráculo actual p0..p9 Node: p0,p1,p8,p3,p4,p2,p6,p5,p7,p9 (sin orden total)', J(root([
  null, 120, '120', '', ' ', '0x80', '1e2', 'NaN', 'oops', 'Infinity', '-Infinity', -0, '1.7976931348623157e308', '5e-324', '-1.7976931348623157e308',
].map((bpm, i) => ({ id: `p${i}`, sort_order: i, name: `bpm${i}`, bpm })))), '-0 numérico serializa como 0 en JSON.stringify: se documenta como límite del fixture JSON');
add('c12-f01-tags', 'oracle-input', 'actual', 'F01: ANY/ALL, include∩exclude, sets vacíos, case/espacios/duplicados; predicados igual al selector real (ANY desde composition)', J({ index: root([
  beat('red', { name: 'Árbol', tags: ['Trap'] }), beat('blue', { sort_order: 1, tags: ['trap', 'Dark'] }), beat('green', { sort_order: 2, tags: [' Trap', 'Dark', 'Dark'] }), beat('none', { sort_order: 3, tags: [] }),
]), queries: [{ include: [], exclude: [] }, { include: ['Trap'], mode: 'ANY' }, { include: ['Trap', 'Dark'], mode: 'ALL' }, { include: ['Dark'], exclude: ['Dark'] }, { include: ['Trap', 'Trap'], mode: 'ANY' }] }));
{
  const beats = [];
  for (let i = 0; i < 241; i++) beats.push({ id: `s${i}`, sort_order: i, name: `n${i}`, bpm: '90', key: 'A', tags: [] });
  beats[240] = { id: 's240', sort_order: 240, name: 'matchÉ', bpm: 'Abc', key: 'A', tags: ['%_\\'] };
  const names = ['á', 'a\u0301', 'i', 'İ', 'ß', 'ss', 'ΟΣ', '%', '_', '\\'];
  names.forEach((n, k) => { beats[k] = { ...beats[k], name: `q-${n}` }; });
  add('c12-f02-search', 'oracle-input', 'candidato-r4', 'F02: substring literal global (match solo en beat 241 = s240 fuera de la primera ventana de 240), sin unaccent, sin cruce entre campos, BPM case literal', J({ index: root(beats), queries: ['á', 'a\u0301', 'i', 'İ', 'ß', 'ss', 'ΟΣ', '%', '_', '\\', 'matchÉ', 'abc', 'Abc'] }));
}

// ---- V01-A paso 1: ventanas ----
for (const n of [0, 1, 239, 240, 241]) {
  const blocks = [];
  for (let start = 0; start < Math.max(n, 1); start += 240) blocks.push({ start, end: Math.min(start + 240, n), forward_boundary: Math.min(start + 240, n) < n, backward_boundary: start > 0 });
  add(`v01a-window-n${n}`, 'window', 'candidato-r4', `N=${n}: bloques de 240 en ambas direcciones con boundary y ordinal esperados; filas por columnas 1..7`, J({
    n, block: 240, blocks: n === 0 ? [] : blocks,
    ordinal_of: { first: n ? 0 : null, last: n ? n - 1 : null },
    rows_by_columns: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((c) => [c, Math.ceil(n / c)])),
    item_id: 'w{ordinal} (generado, no materializado en cliente)',
  }));
}
// ---- V01-A paso 2: metadata larga / artwork ----
add('v01a-long-metadata', 'window', 'candidato-r4', 'metadata larga ejerce límites C5/C12-L01 sin superar 2 MiB por bloque de 240; artwork con retardo 2 s y con error', J(root(Array.from({ length: 240 }, (_, i) => ({
  id: `L${i}`, sort_order: i, name: 'Ñ'.repeat(200) + i, bpm: '1'.repeat(32), key: 'C#m', tags: Array.from({ length: 20 }, (_, t) => `tag-${t}-${'é'.repeat(20)}`),
  artwork: i % 3 === 0 ? { ...ref(1000 + i), x_fixture_delay_ms: 2000 } : i % 3 === 1 ? { ...ref(2000 + i), x_fixture_error: 'HTTP_500' } : null,
})))), 'campos x_fixture_* los interpreta solo el servidor fake de T02');
// ---- V01-A paso 3: estado externo ----
add('v01a-external-state', 'external-state', 'candidato-r4', 'currentBeat fuera de ventana, selección y borrador offscreen, cola con IDs no cargados, cuenta A→B distinguible; evicción ≠ borrado', J({
  window: { start: 240, end: 480 }, currentBeat: 'w5', selection: { token: 'sel-1', count: 3, includes: ['w1', 'w700'] }, draft: { beat_id: 'w2', field: 'name', value: 'borrador' },
  queue: ['w999', 'w5', 'w100000'], accounts: { A: { prefix: 'A-', n: 300 }, B: { prefix: 'B-', n: 2 } },
  expect: ['audio continúa', 'selección sobrevive evicción', 'cola conserva IDs no cargados', 'A→B limpia cachés y no mezcla IDs A-/B-'],
}));
// ---- V01-A paso 4: generador grande (no materializado) ----
function bigDigest(n, seed) {
  const r = rng(seed); const h = crypto.createHash('sha256');
  for (let i = 0; i < n; i++) h.update(`g${i}|${Math.floor(r() * 200)}|${Math.floor(r() * 1e6)}\n`);
  return h.digest('hex');
}
const big = { seed: SEED, line_format: 'g{ordinal}|{bpm=floor(r*200)}|{nameKey=floor(r*1e6)}\\n (mulberry32)', digests: { 100000: bigDigest(100000, SEED), 1000000: bigDigest(1000000, SEED) } };
add('v01a-big-generator', 'oracle-input', 'candidato-r4', 'digest incremental de la secuencia completa para V10; bloques bajo demanda en el servidor fake, nunca array en cliente', J(big));

// ---- escritura / check ----
const manifest = {
  generator: 'cloud-server/tests/fixtures/catalog/generate-fixtures.cjs', generator_version: GENERATOR_VERSION, seed: SEED, head: 'a4462191',
  note: 'Fixtures sintéticos T01/V01-A. No cubren todas las bibliotecas reales. expected: actual=HEAD observado, candidato-r4=contrato aprobado, review=debe ir a REVIEW.',
  fixtures: fixtures.map(({ content, ...f }) => ({ ...f, bytes: Buffer.byteLength(content), sha256: sha(content) })),
};
const check = process.argv.includes('--check');
const BIG = process.argv.includes('--big');
const onDemand = (id) => id === 't01-over-rollback-budget';
manifest.fixtures.forEach((f) => { if (onDemand(f.id)) f.on_demand = true; });
if (check) {
  const disk = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  let bad = 0;
  for (const f of manifest.fixtures) {
    const d = disk.fixtures.find((x) => x.id === f.id);
    if (f.on_demand && !BIG) { if (!d || d.sha256 !== f.sha256) { bad++; console.error('MISMATCH', f.id); } continue; }
    const onDisk = fs.existsSync(path.join(DIR, f.file)) ? sha(fs.readFileSync(path.join(DIR, f.file))) : null;
    if (!d || d.sha256 !== f.sha256 || onDisk !== f.sha256) { bad++; console.error('MISMATCH', f.id); }
  }
  if (disk.fixtures.length !== manifest.fixtures.length) { bad++; console.error('COUNT', disk.fixtures.length, manifest.fixtures.length); }
  console.log(bad ? `FAIL ${bad}` : `OK ${manifest.fixtures.length} fixtures reproducibles`);
  process.exit(bad ? 1 : 0);
}
for (const f of fixtures) if (BIG || !onDemand(f.id)) fs.writeFileSync(path.join(DIR, f.file), f.content);
fs.writeFileSync(path.join(DIR, 'manifest.json'), J(manifest));
console.log(`wrote ${fixtures.length} fixtures`);
