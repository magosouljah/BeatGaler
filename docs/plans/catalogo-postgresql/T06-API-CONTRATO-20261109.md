# T06 — Contrato de lectura `/catalog/v1` y decisiones V02-A (2026-11-09)

**Alcance:** T06 según [TAREAS](TAREAS.md) §T06, [MATRIZ-T](MATRIZ-T-NIVELES-20261107.md) §T06, [MATRIZ-V](MATRIZ-V-NIVELES-20261107.md) §V02, [C12-DECISION-RECORD](C12-DECISION-RECORD.md) §§3–5 y [C12-r4](C12-V00-CIERRE-20261107.md) §§2–6, sobre la arquitectura nativa [NATIVO r2.1](NATIVO-POSTGRES-20261108.md) §3.3. El manifiesto tipado y ejecutable es `cloud-server/catalog/api-manifest.json`; este documento registra las decisiones y su justificación. Nada de aquí toca Telegram.

## 1. Entregado en T06 (implementado y probado)

| Pieza | Archivo | Resumen |
| --- | --- | --- |
| Migración 0028 | `cloud-server/migrations/0028_catalog_queries.sql` | Colación ICU `und` no determinista `catalog_name_icu_und_v1` (A1; sin ICU la migración falla: STOP-DESIGN-A, nunca libc). Proyecciones display/search NOT NULL en `catalog_beats` (`name_display`, `name_search`, `key_display`, `key_search`, `bpm_display`, `rating_display`) y `catalog_beat_tags.search_key`. Índices por tupla completa con `beat_id COLLATE "C"` para manual/rating/name/bpm e índice de facetas. Aditiva; solo `SET NOT NULL` sobre columnas que ella misma añade. |
| Proyección JS | `cloud-server/catalog/legacy-codec.js` `projectBeat` | `search-js-v1` + display de `webLibrary.ts:165-193` materializados por el escritor (import T04, comandos T07). Tags: `norm_key` (trim+lower, facetas) y `search_key` (lower, predicado q). |
| Cursores | `cloud-server/catalog/cursor.js` | `base64url(payload).base64url(HMAC-SHA256)`, verificación en tiempo constante, canonicidad obligatoria, 16 KiB, `kid` con retiro (retirado → 409 `CURSOR_STALE`; desconocido → 400). Claves `BEATGALER_CATALOG_CURSOR_KEYS`; sin variable, clave efímera de proceso (solo LOCAL/CI; T16 la exige). |
| Consultas | `cloud-server/catalog/queries.js` | Lista keyset (first/forward/backward, `resumeCursor` inclusivo, `edge=last`), detalle, archivos, resolver legacy §5.2, facetas r4 §6, conjuntos r4 §3 (create/step/cancel/release). Transacción `REPEATABLE READ READ ONLY`, `statement_timeout` 1000 ms, tope 2000 ms → 503 `CATALOG_QUERY_TIMEOUT`, página > 2 MiB → 413. |
| Rutas | `cloud-server/catalog/routes.js` | Montaje en `server-core.js` tras `express.json`; auth Cloud existente; errores JSON estables; sin autoridad → 503 `CATALOG_UNAVAILABLE`; contratos no implementados → 501 `NOT_IMPLEMENTED`. |
| Pruebas | `tests/catalog/catalog-cursor.test.cjs`, `catalog-queries.test.cjs`, `catalog-routes.test.cjs`, `catalog-queries.integration.cjs` | Suite `T06` del runner (`node scripts/catalog-check.cjs T06`), incluida en el push de `catalog-checks`. |

## 2. Reglas fijadas

- **Orden (C12 §4.3):** `manual = (manual_rank, beat_id C)`, `rating = (255 − rating_display, manual_rank, beat_id C)`, `name = (name_display COLLATE icu-und, manual_rank, beat_id C)`, `bpm = (bpm_sort_class, coalesce(bpm_sort,0), manual_rank, beat_id C)`. Todas las claves ascendentes para usar comparación de filas (`ROW(...) > ROW(...)`) en ambas direcciones con el mismo índice; `edge=last` y `backward` leen el índice hacia atrás y revierten en memoria.
- **Filtros (C12 §3.4):** q canónico `trim().toLowerCase()` en JS; `LIKE` escapado con `COLLATE "C"` sobre `name_search`, `key_search`, `bpm_display` (sin lowercase) y `catalog_beat_tags.search_key`. Tags exactos por igualdad; `includeMode=any|all`; exclusión vence. Todo antes de `LIMIT`.
- **Ordinal y total:** `startOrdinal` viaja firmado; `nextCursor` avanza por la cantidad devuelta; `previousCursor` desde ordinal ≥ `limit` es el bloque anterior exacto, desde 1…`limit−1` es `first`; ordinal 0 → `null`. `totalMatched` del mismo snapshot: contadores sin filtros, `COUNT` exacto con `includeTotal` o `edge=last`, firmado en los cursores siguientes.
- **Stale:** revisión/era/época/generación/perfil distintos → 409 `CURSOR_STALE`; filtros/sort/limit/tenant distintos → 400 `CURSOR_INVALID` sin dato alguno de otra cuenta.
- **Legacy (§5.2, r4 §2):** `offset` decimal canónico seguro; `N=0` vacío certificado; `offset ≥ N` → último bloque por índice inverso (`resolution=last`); `offset ≤ 10.000` → único `OFFSET` acotado sobre claves del índice; `10.000 < offset < N` → 409 `LEGACY_OFFSET_UNRESOLVABLE` con copy «Este enlace antiguo no se puede abrir en esta posición.» y acción «Ir al inicio». Siempre devuelve `resumeCursor` reabrible por `GET /beats`.
- **Facetas (r4 §6):** `beat_count DESC, rep_label COLLATE icu-und, norm_key COLLATE "C"`; representante = primer `manual_rank`; activos por identidad en `/facets/active`.
- **Conjuntos (r4 §3):** recurso propio; un `BUILDING` por biblioteca; reuso por (generación, predicado, revisión); pasos ≤ 240 en orden manual con checkpoint atómico (`members + frontier + member_count + checkpoint_seq`); contexto cambiado → `STALE`; `READY` bajo `FOR UPDATE` de `catalog_libraries` con revisión re-comprobada y trigger de slots densos. Scheduling, leases abandonados y limpieza: T10.

## 3. Decisiones V02-A (Q1–Q5)

Registradas en `api-manifest.json#v02a_decisions`. Resumen: **Q1** recurso `POST /query-sets` (no creación implícita). **Q2** selección server-side sobre conjunto READY con `defaultSelected`, inclusiones/exclusiones y rangos inclusivos por slot, CAS `selectionVersion` + `idempotencyKey`, precedencia de la última operación confirmada; implementación T07. **Q3** facetas por frecuencia/nombre A1/clave binaria, entregadas. **Q4** comandos musicales `next/previous/consume` con `sequence` CAS e `idempotencyKey`, resultado persistido en la misma transacción que el swap; implementación T14. **Q5** stale por defecto (409 → recarga del primer bloque conservando filtros); no se reancla por ID hasta que T20 justifique su coste con EXPLAIN; si se añade, será `anchorBeatId` compatible, sin endpoint nuevo.

## 4. Decisiones de implementación (D-T06)

- **D-T06-1:** sin `pg_trgm` en 0028. El contrato lo deja opcional; las búsquedas recorren solo el rango `(user, generation, state)` del índice de orden. T20 mide q de 1–2 caracteres y decide si se añade GIN como migración aditiva.
- **D-T06-2:** claves de cursor por variable de entorno con fallback efímero. Un reinicio o varias instancias sin la variable invalidan cursores (400). T16 (capa 2) hace obligatoria la variable en entornos activados.
- **D-T06-3:** el backfill SQL de proyecciones en 0028 solo aproxima la semántica JS para filas de laboratorio preexistentes (no hay bibliotecas reales); toda escritura nueva materializa la proyección desde JS.
- **D-T06-4:** `POST /library/provision` responde 201 al crear y 200 al reencontrar la fila (idempotente, §3.3).
- **D-T06-5:** `GET /beats/:id` expone `ETag` débil `W/"<len(id)>-<version>"`; `If-Match` se evalúa en T07.
- **Observación LAB:** insertar 100k tags tras 100k beats sin `ANALYZE` cachea un plan de comprobación FK con seq scan (horas). No afecta a la API (escrituras por beat); la prueba sintética analiza entre cargas. Queda anotado para T19/T20 (restores y cargas masivas).

## 5. Fuera de T06 (adscrito)

PATCH/trash/restore, selecciones, rename y feed `/changes` (T07); operaciones y recibos (T09); scheduling de conjuntos (T10); rondas Shuffle y acceso a medios por gateway (T14); clave de cursores y capa 2 (T16). Cliente Web (T08) consume solo lo que este manifiesto marca `delivered`.
