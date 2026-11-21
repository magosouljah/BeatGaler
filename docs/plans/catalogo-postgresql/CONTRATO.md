# Contrato técnico propuesto

**Enmiendas nativas (2026-11-08, PROPUESTA pendiente de aprobación):** [NATIVO-POSTGRES-20261108.md](NATIVO-POSTGRES-20261108.md) §8 enmienda C1.2–C1.4, C1.9, flags, C3 (0027 aditiva), C4 (importador inactivo, sin cota reversible), C5 (`LIBRARY_RESET_REQUIRED`), C9, C10 (cerco por vault y por entorno), C12 (*Rollback* sin objeto) y MIGRACION. No hay usuarios reales: las bibliotecas nacen POSTGRES y nunca hay fallback a legacy. El resto de C1–C12 y C12-B sigue vigente.

**Vigencia C12-r4 (2026-11-07):** [cierre C12-r4](C12-V00-CIERRE-20261107.md) integra el [acta I1/I2/I3 aprobada](C12-V00-INTERACCIONES-APROBADAS-20261107.md) de `c6d7b7cf4455623ab2da7bfbdadabb0b4b3e3b81` y las respuestas explícitas del usuario de este encargo. **A1/A2/B-legacy e I1/I2/I3 aprobados; decisiones C12/V00 cerradas para diseño.** Shuffle sin repetición por ronda, aviso de selección solo si existía y rename también en papelera sin alterar su estado. Las menciones pendientes r2/r3 quedan como antecedentes, sustituidas por r4. **T00/G0 no PASS; T01 bloqueada; T02 no iniciada.** No hay autorización de implementar.


Versión del plan: 1. Las reglas C1–C12 son decisiones de diseño, no afirmaciones sobre capacidades existentes. La IA ejecutora las implementa después de G0; si una resulta incompatible, se detiene y pide revisión de alta capacidad mediante ESTADO.

**Precisiones vigentes C12-r4:** [acta](C12-DECISION-RECORD.md), [cierre V00](C12-V00-CIERRE-20261107.md) y [plan B](C12-B-INTEGRACION-Y-PLAN-20261107.md). A1/A2/B/I1/I2/I3 aprobados. C3 bpm_sort numeric se sustituye en el diseño por proyecciones binary64/clase; raw separado permanece. T01 mapa exhaustivo antes de tablas; G0 no aprobado. En C5 página significa bloque interno, nunca pager POSTGRES.


## C12-B. Contrato de Gallery continua aprobado (integración r3)

- POSTGRES usa virtualización por filas dentro del scroller de AppShell, sin números de página ni Previous/Next visibles.100/240 siguen como límites de bloques SQL/keyset. Búsqueda/ANY/exclusión/orden son globales antes de LIMIT; no selector local de la ventana.
- Preservar geometría declarada LOCAL y medir altura/columnas/gaps/padding reales; propuestas de overscan/budgets del plan B se verifican, no se declaran medidas. DOM, bloques, cursores, artwork y recursos acotados; recuperar atrás por boundary, sin INDEX ni recorrer desde inicio.
- Identidad/estado de Player, audio, selección, editor y operaciones independientes de tarjetas/evicción. No podar ni releaseFile por ausencia en windowItems. Hover/menu/listeners se limpian; media conserva ownership por versión.
- Cambiar query resetea al inicio; prepend/evict/resize/detalle con revisión vigente conserva anchor. Account switch invalida datos/cursores anteriores. Sin fallback a legacy por error.
- Pager y WebLibraryWindowConsumer actuales solo LEGACY; Desktop fuera del catálogo. Manual reorder Web sigue desactivado por capability, no introducirlo. OS file drop conserva target por ID/version.
- Ancla de bgPage no produce pager. Cota10.000/copy/fallback legacy no aprobados. Alcances Select All, cola automática/shuffle y facetas/rename se cierran con los STOP específicos del plan B antes de activar; no adoptar scope de la cache por silencio.
- No modificar DESIGN ni reemplazar la Playbar; futura adaptación de props de GalleryChrome mediante composición y CSS producto scoped. Todos los gates y límites C1–C11 conservados.

## C1. Autoridad e invariantes

1. El tenant es `users.id`, obtenido de autenticación server-side. `installationId`, `beatgalerUserId`, `chatId` enviados por cliente no eligen al propietario. Resolver el vault por su relación SQL con ese usuario.
2. Una biblioteca tiene una sola autoridad de lectura y escritura: `LEGACY` o `POSTGRES`. `SHADOW`, `FREEZING`, `FROZEN`, `ROLLBACK` y `REVIEW` son estados de migración, no autoridades adicionales.
3. `catalog_libraries` persiste `authority`, `migration_state`, `epoch`, `revision` y `active_generation_id`. Default para vault existente: LEGACY; nunca inferir biblioteca vacía porque falte INDEX/puntero.
4. POSTGRES implica catálogo completo validado. No fallback a INDEX, JSON local, rutas enviadas por cliente ni cache para confirmar una escritura. Un error de DB produce error de servicio, no biblioteca vacía.
5. Ninguna operación nueva retiene transacción, cliente del pool ni advisory lock mientras espera Telegram, archivos temporales, S3 u otra red externa. Los pequeños cálculos de validación se hacen antes de BEGIN.
6. Toda mutación de catálogo toma primero la fila `catalog_libraries FOR UPDATE`, después filas de beats en orden de ID, después archivos/operaciones. Esta serialización **breve por biblioteca** permite contadores y revisión consistentes; no se mantiene durante upload. Medir contención, no prometer escalado ilimitado de una biblioteca.
7. Dentro de esa transacción se vuelven a comprobar autoridad, época, estado, versión y permiso aplicable. Lecturas de páginas usan una transacción SQL breve y consistente para revisión + filas; no mantienen snapshots entre peticiones.
8. Una edición afecta como máximo un beat y sus filas asociadas. Los batches aceptan hasta 50 beats explícitos. Nada de actualizar `sort_order` de todos al insertar. Operaciones globales legítimas, como exportar o purgar toda la papelera, se recorren en jobs acotados.
9. `library_beats` es autoridad legacy hasta el corte; después es proyección de ocupación compatible, escrita dentro de la transacción del catálogo. No importar de ese ledger hacia POSTGRES. Su divergencia provoca REVIEW; no reparación automática bidireccional.
10. `PURGING` sigue ocupando cuota; solo `PURGED` la libera. Papelera/restauración no cambian ocupación. Una reserva se cuenta una vez y se consume una vez. Respetar el resolver Access vigente; no cambiar planes, promociones ni límites comerciales.
11. Beat purgado conserva identidad/tombstone para siempre mientras exista la cuenta. Reimportar esos bytes exige un ID nuevo. Un retry no puede resucitar el anterior.
12. Las referencias de un archivo son inmutables después de verificarse. Reemplazar crea nueva versión y cambia un vínculo; nunca sobrescribe bytes in situ.
13. “No pérdida” se evalúa dentro de un modelo explícito: concurrencia y fallos de nuestros procesos. Pérdida permanente de Telegram requiere otra copia de bytes; SQL y snapshots de metadatos no la resuelven.

Flags propuestos: `BEATGALER_CATALOG_API_ENABLED=false`, `BEATGALER_CATALOG_WORKER_ENABLED=false`, `BEATGALER_CATALOG_PHYSICAL_DELETE_ENABLED=false`. Son interruptores de disponibilidad, no selectores de autoridad: si una biblioteca es POSTGRES y se apaga la API, devuelve 503; jamás entra en legacy. La guarda de autoridad permanece activa aun con estos flags apagados. El permiso de cleanup exige el flag global **y** los permisos persistentes por biblioteca.

Además de epoch, cada biblioteca tiene `authority_era` UUID. Normalmente permanece fija; tras restaurar una DB se emite una era nueva mediante un manifiesto externo al backup. Contexto, operaciones, jobs, capabilities y cursores se ligan a `(era,epoch)`. El header `X-Catalog-Era` es obligatorio junto a epoch en escrituras. A lo largo de este documento “comprobar época” incluye comprobar era. Así un contador antiguo restaurado no coincide con credenciales emitidas después del backup.

## C2. Organización y reutilización

Nuevos módulos CommonJS en `cloud-server/catalog/`: `authority.js`, `contract.js`, `legacy-codec.js`, `repository.js`, `queries.js`, `commands.js`, `operations.js`, `transport.js`, `worker.js`, `routes.js`, `migration.js`, `backup.js`. Cada módulo exporta una fábrica con dependencias inyectadas; no inicia servicios, carga `.env` ni conecta al importarse.

Clientes nuevos en `src/features/catalog/`: `catalogClient.ts`, `catalogTypes.ts`, `catalogLibrary.ts`, `catalogMutations.ts`, `catalogChanges.ts`. La selección de autoridad se integra en `src/platform/webAdapter.ts`; no diseminar `if postgres` por componentes.

Reusar autenticación/Access, pool y runner de migraciones existentes. No copiar las reglas de billing. Adaptar las envolturas Express de capabilities y startup routing: inspeccionar el orden efectivo de middleware, incluidas rutas instaladas por monkey patch, antes de registrar `/catalog/v1`.

`direct_operations` sigue representando la actividad de transporte existente. `catalog_operations` representa un comando durable del catálogo que puede sobrevivir a varias sesiones Direct. Se pueden enlazar por ID, pero no confundir sus estados ni imponer `INDEX_COMMITTED` a POSTGRES.

El worker nuevo usa `catalog_jobs` porque necesita leases y épocas que `jobs` no declara actualmente. No habrá dos workers borrando el mismo objeto: migración/guardas bloquean todo cleanup legacy de una biblioteca POSTGRES, y el importador registra lo pendiente. El journal legacy se conserva como evidencia; no se vacía.

## C3. Esquema de destino

Migraciones **aditivas** a partir del siguiente número disponible (en la base inspeccionada, 0026). No editar SQL ya aplicado ni sus checksums. `CREATE INDEX CONCURRENTLY` no cabe en el runner transaccional actual: para tablas nuevas, índices normales; un índice concurrente sobre tabla grande existente requiere tarea operativa separada y revisión.

Convenciones: tiempos `timestamptz`; IDs de negocio `text`; versiones, época y revisión `bigint > 0` representados como strings decimales en JSON; tamaños `bigint >= 0`; hashes SHA-256 con formato validado. IDs Telegram de chat/documento se conservan como texto decimal cuando proceda. Nunca convertir un entero de 64 bits a Number sin comprobar rango seguro.

PK/FK de entidades subordinadas a un snapshot incluyen siempre usuario y generación. Operaciones, objetos físicos y biblioteca pertenecen al usuario a través de generaciones; sus claves incluyen usuario y sus relaciones con un snapshot incluyen generación explícita. Una FK solo por `file_id` o `beat_id` no acredita pertenencia. Añadir UNIQUE `(user_id,id)` en `vaults` para FK compuesta del catálogo. El `user_id` de un vault no cambia durante la migración.

| Tabla propuesta | Columnas esenciales y restricciones |
| --- | --- |
| `catalog_libraries` | `user_id PK`, `vault_id UNIQUE`, FK `(user_id,vault_id)→vaults(user_id,id)`; authority LEGACY/POSTGRES; migration_state IDLE/SHADOW/FREEZING/FROZEN/ROLLBACK/REVIEW; authority_era UUID, epoch, revision; active_generation_id nullable mientras LEGACY; contadores active/trash/purging/pending, export_bytes_estimate, rollback_max_bytes, cleanup_enabled=false, restore_hold=true inicialmente. Counts nunca negativos. |
| `catalog_generations` | PK `(user_id,generation_id)`; snapshot_id, estado STAGING/VALIDATED/ACTIVE/RETIRED, source_hash, validated_at. FK de generación activa misma cuenta, diferible si hace falta para crear la pareja en una transacción. Ninguna generación STAGING puede servirse como autoridad. |
| `catalog_beats` | PK `(user_id,generation_id,beat_id)`; state ACTIVE/TRASH/PURGING/PURGED; version; name,bpm_text,key_text,rating,color,color2; bpm_sort numeric nullable; manual_rank numeric(40,0); timestamps; `legacy_json` por beat; `legacy_presence` para ausencia/null; `legacy_export_bytes`; projection_version. Metadata canónica y proyecciones solo cambian por commands. |
| `catalog_beat_tags` | PK `(user_id,generation_id,beat_id,position)`; label text, búsqueda normalizada; FK al beat. Preservar orden, mayúsculas y repetidos históricos. Índice `(user_id,generation_id,label,beat_id)`. No deduplicar ni casefold del dato original. |
| `catalog_trash_entries` | PK de beat; `trash_id`, `trashed_at`, `purge_after`, posición de export y JSON wrapper original sin el beat; UNIQUE trash_id por cuenta/generación. El ID histórico se conserva. |
| `catalog_tombstones` | PK de beat; source INDEX/SQL/BOTH/CATALOG, deleted_at nullable, JSON original/variantes y posición. Unión validada de INDEX.deleted y `library_trash_purges`; conflicto vivo vs tombstone → REVIEW. |
| `catalog_file_versions` | PK `(user_id,generation_id,file_id)`; beat_id FK, role MASTER/WAV/ARTWORK/PROJECT/SAMPLES/STEMS/LOOP/LEGACY_OTHER/METADATA; legacy_path, revision, filename,mime,size_bytes nullable para legacy, declared_sha256, verified_sha256 nullable, status STAGED/VERIFIED/RETIRED/DELETING/DELETED/REVIEW; original_json; retained_until; backup_state NONE/PENDING/VERIFIED/FAILED. No deduplicación por hash entre beats. |
| `catalog_file_parts` | PK `(user_id,generation_id,file_id,part_index)`; tamaño, hashes, payload original. Índice base cero y orden explícito; no asumir que primeras partes bastan para descargar o purgar. FK al archivo. |
| `catalog_media_objects` | Identidad física PK `(user_id,object_id)` y UNIQUE `(user_id,provider,chat_id,message_id)` para Telegram; document_id, sender_id, topic_id, verified_at, status PRESENT/DELETING/DELETED/UNKNOWN, deletion_generation. Objeto compartido usa la misma fila incluso entre generaciones; no duplicar el objeto físico por beat/snapshot. |
| `catalog_part_locations` | FK a parte del mismo usuario/generación y a objeto físico del mismo usuario; provider, ubicación primaria/backup, locator, verification_level PROVIDER/BYTES, checksum/fecha. URI/clave de backup no sustituye checksum. Los file_reference Telegram efímeros se renuevan mediante message ID. |
| `catalog_current_files` | PK `(user_id,generation_id,beat_id,slot_key)`; file_id FK compuesta que incluye beat_id mediante UNIQUE de la versión. Slots singular MASTER/ARTWORK/PROJECT; entradas `files` se identifican por posición/clave legacy para conservar tipos repetidos. Cliente nuevo crea solo roles ya soportados. |
| `catalog_legacy_fields` | PK `(user_id,generation_id,scope,key,ordinal)`; campos root desconocidos y filas de garbage/deleted extras separados. No guardar beats/trash en un único root JSON. Clasificación de referencias KNOWN/OPAQUE; OPAQUE impide cleanup hasta revisión. |
| `catalog_operations` | PK `(user_id,operation_id)`; UNIQUE `(user_id,idempotency_key)`; authority_epoch, request_hash, kind, beat_id, expected_version, generation_id, status; response_json, error_code; expires_at; created/updated. No borrar identidad de operaciones completadas durante la ventana reversible. |
| `catalog_operation_parts` | PK `(user_id,operation_id,part_key)`; file_id, random_id text, dispatch_nonce, byte_count/hash declarado, provider_receipt, verification, attempt_state, sender identity. UNIQUE sobre identidad del envío dentro de cuenta. |
| `catalog_reservations` | PK `(user_id,operation_id)`; beat_id UNIQUE parcial mientras pendiente, estado PENDING/COMMITTED/CANCELED/EXPIRED, expires_at. Nuevo motor de reserva para POSTGRES; no usar el ID legacy `new:beat` como identidad de cada operación distinta. |
| `catalog_jobs` | id PK, user_id/operation_id FKs, kind, epoch, state READY/LEASED/RETRY/DONE/BLOCKED; payload acotado, attempt_count, next_attempt_at, lease_owner, lease_until, lease_generation. UNIQUE job idempotency key. Índice parcial por estado/next_attempt_at. |
| `catalog_events` | PK `(user_id,revision,ordinal)`; epoch, beat_id nullable, beat_version, event_type, operation_id. Se inserta en la misma transacción que el cambio. Feed ordenado, sin manifests ni bytes. |
| `catalog_purge_items` | PK `(user_id,operation_id,object_id)`; snapshot de referencias/partes, estado PENDING/DELETING/CONFIRMED/BLOCKED, intent_at, verification_at, error, backup/journal_ref. Conservación independiente del beat eliminado. |
| `catalog_migration_runs` | run_id PK, user_id, from/to authority, expected_epoch, snapshot hashes, stage, checkpoint, evidencia y resultado. No actualizar autoridad directamente con SQL manual. |

No es necesario que todas las columnas se añadan en la primera migración. T03 crea catálogo; T07 añade operations para metadata y events; T09 añade parts/reservations/jobs y extiende operations para transferencias; T15 añade purge items. Cada FK, transición y CHECK debe quedar probado antes de usarlo. Todas las operaciones/jobs/eventos/migration runs guardan también authority_era además de epoch cuando corresponda.

`catalog_beats.legacy_json` preserva el objeto individual, incluidos campos no visibles. No es una segunda autoridad editable: el codec aplica el parche explícito sobre el objeto guardado y recalcula proyecciones en la misma transacción. Verificación periódica comprueba igualdad entre campos proyectados y codec. Se puede optimizar después; no eliminar el payload durante la ventana de reversión.

## C4. Importación y exportación sin pérdida

El importador acepta **un archivo local explícito**, evidencia SQL exportada y descriptor de snapshot. No descubre bibliotecas ni llama Telegram por defecto. Trabaja sobre una nueva generación STAGING, nunca actualiza una activa.

Descriptor: user/vault, SHA origen, versión de esquema, pin message ID, puntero SQL, hash de ledger, hash raw del INDEX, hora de captura, bytes, conteos, estado de operaciones pendientes y procedencia de cada export. Información sensible en artefacto protegido, no en logs públicos.

Mapa obligatorio por JSON path: root `schema/version/updated_at`; `beats[*]` completos; `trash[*]` wrapper y beat; `deleted[*]`; `garbage[*]`; master, artwork, metadata_message_id, telegram_topic_id, `files[*]`, project y todos los manifests/parts; `sort_order`; tags; flags legacy. Cada path tiene destino, tipo/rango, regla de export y fixture. Campos inesperados se conservan; referencias ambiguas se marcan OPAQUE.

Normas:

- No usar `beatFromWebLibraryEntry` ni normalizadores UI como importador: pierden información o eligen solo el primer archivo/parte.
- Capturar raw bytes con hash para auditoría. El roundtrip sin modificaciones exige igualdad semántica profunda, incluido orden de arrays, tipos, campos ausentes/null y extensiones. No exige igual orden de claves JSON o whitespace; conservar raw permite comprobar el origen exacto.
- JSON con claves duplicadas, enteros no seguros, identidad duplicada/ambigua, versiones no soportadas o referencias inconsistentes → REVIEW, no “corregir” ni normalizar silenciosamente.
- Copiar todos los recibos PROJECT y tombstones SQL pertinentes. PENDING purge o operación externa incierta impide validar para corte. LEGACY_TOMBSTONE no equivale a confirmación de borrado físico.
- Comparar dos productos distintos: `source-roundtrip` reconstruye exactamente la semántica del INDEX fuente; `authoritative-export` incorpora además los tombstones SQL-only validados. Esa adición se lista como delta esperado, nunca se oculta como igualdad con el INDEX original. Para un tombstone sin timestamp verificable preservar ausencia/null; no inventar la fecha actual. El export para rollback siempre usa la unión autoritativa.
- Legacy multipartes se conservan; nuevas subidas Web siguen la restricción actual de un documento por archivo. No convertir multipartes al vuelo ni copiarlas al importar.
- `metadata_message_id` y referencias de extras también participan en retención/purge. `direct:` no se considera el único formato histórico posible: uno desconocido se preserva y bloquea la operación que necesite interpretarlo.
- Importar por lotes de 250 beats con checkpoint `(snapshot_hash,ordinal)` y transacciones breves. Repetir mismo snapshot/run no duplica; snapshot distinto necesita generación distinta.
- Comparar inventario por identidad, estado, ruta de cada referencia, tags, tamaños, partes, wrappers, tombstones y JSON desconocido, además de conteos/hashes. Dos conteos iguales no bastan.
- Exportar la generación activa a archivo temporal local, terminar, fsync/cerrar, calcular hash y renombrar. Snapshot consistente para export: biblioteca FROZEN o una copia DB consistente; no sostener transacción mientras publica en Telegram/S3.
- Tras escrituras nuevas exportar estado actual, mergeando extras; cambiar solo campos realmente editados. Generar `sort_order` contiguo al exportar si hubo cambios de orden/inserciones; conservar el orden visible. Registrar esta normalización permitida, no ocultarla como roundtrip idéntico.

Presupuesto reversible: `rollback_max_bytes = 15 * 1024 * 1024` inicialmente (propuesta conservadora frente al límite existente de 16 MiB). Contabilizar bytes UTF-8 escapados de cada fragmento, separadores, wrappers, tombstones y root. Usar cota superior para `sort_order` regenerado y timestamps. Actualizar deltas en la transacción, nunca exportar toda la biblioteca en cada PATCH. Bloquear con `ROLLBACK_CAPACITY_EXCEEDED` antes de aceptar un cambio que supere la cota. Validar periódicamente export real y que `estimate >= actual`; si falla, congelar escrituras y revisar. Bibliotecas ya mayores quedan fuera del piloto reversible.

## C5. Contrato HTTP y cliente

Autenticación Cloud existente, sin exigir conexión Telegram para catálogo. Cada endpoint de escritura requiere `Idempotency-Key`, `X-Catalog-Epoch` y `X-Catalog-Era` conforme a C1. PATCH/trash/restore/reemplazo exigen versión por beat, mediante `If-Match` de detalle o `expectedVersion` en comandos. Si ambas formas se envían deben coincidir. Época y versión no son intercambiables.

| Endpoint propuesto | Entrada / salida |
| --- | --- |
| `GET /catalog/v1/context` | authority, epoch, revision, migrationState, capabilities, límites de API. No accede Telegram. Solo contexto autenticado, nunca credenciales. |
| `GET /catalog/v1/beats` | state ACTIVE/TRASH, q, tags incluidos/excluidos, includeMode, sort, cursor, limit. Default 100, máximo 240. `{items,nextCursor,previousCursor,epoch,revision}`. Contador total sin filtros desde contadores; no COUNT global obligatorio para cada búsqueda. |
| `GET /catalog/v1/beats/:id` | Metadata, version, ETag y referencias actuales; archivos/partes extensos en endpoint paginado. No devuelve raw legacy JSON ni binarios. |
| `PATCH /catalog/v1/beats/:id` | Set explícito de name,bpm,key,tags,rating,color,color2 y crop soportado; respuesta beat actualizado y versión. No acepta userId, state, file locators, `legacy_json` ni objetos arbitrarios. |
| `POST /catalog/v1/beats/trash` y `/restore` | Hasta 50 `{beatId,expectedVersion}`; transacción atómica del lote. Todo falla ante un conflicto, sin aplicación parcial silenciosa. |
| `POST /catalog/v1/operations` | kind IMPORT/REPLACE/PURGE, metadata/intención acotada, versiones y tamaños declarados. Devuelve operationId y estado; el servidor elige sender/vault y reserva. |
| `PUT /catalog/v1/operations/:id/parts/:partKey/receipt` | Recibo candidato; guarda evidencia, no confía en el cliente como verificador. Mismo recibo → replay, diferente → conflicto. |
| `POST /catalog/v1/operations/:id/commit` | Idempotente; 202 si falta verificación, 200 si COMMITTED, 409 si conflicto; no espera un upload dentro de transacción. |
| `POST /catalog/v1/operations/:id/cancel` | No revierte una operación ya confirmada. Si hubo posible envío queda RECONCILE, con objetos retenidos. |
| `GET /catalog/v1/operations/:id` | Estado durable y progreso. No usa una sesión Direct expirada para decidir propietario. |
| `GET /catalog/v1/beats/:id/files` | Versiones/partes visibles autorizadas, limit máximo 100; descarga resuelve todas las partes por páginas. |
| `POST /catalog/v1/files/:fileId/access` | Verifica dueño, beat/estado, versión y Access; entrega descriptor acotado para transporte existente. No autoriza un messageId arbitrario. |
| `GET /catalog/v1/changes?after=...` | Máximo 240 eventos; cursor viejo → 410 `RESYNC_REQUIRED`, recarga páginas visibles. No descargar el catálogo entero. |

Errores estables: 400 INPUT_INVALID/CURSOR_INVALID; 401 no autenticado; 403 permiso; 404 identidad no accesible (también tenant ajeno); 409 VERSION_CONFLICT/EPOCH_MISMATCH/IDEMPOTENCY_MISMATCH/LIBRARY_FROZEN/CURSOR_STALE/PURGE_PENDING/QUOTA_EXCEEDED/ROLLBACK_CAPACITY_EXCEEDED; 410 LEGACY_CLIENT_UNSUPPORTED/RESYNC_REQUIRED; 428 PRECONDITION_REQUIRED; 503 CATALOG_UNAVAILABLE. No respuesta 200 vacía ante error.

Idempotencia: hash canónico de tipo+target+payload+expectedVersion; UNIQUE por usuario+key. Misma key y contenido devuelve resultado persistido; contenido distinto → 409, sin nuevos efectos. No aplicar a operaciones de otro usuario. Guardar resultado y efecto SQL en la misma transacción. Una operación desconocida no se reconstituye a partir del nombre de archivo. Tras cambio de época, un POST con época vieja falla; GET del resultado histórico sigue disponible para su propietario.

Validación de nuevos valores: trasladar con pruebas de paridad las reglas de `src/lib/metadataValidation.ts` para BPM, tonalidad y tags al contrato compartido con Cloud. Hoy BPM admite vacío o 60–300 con hasta dos decimales; tags usan reglas de 40 caracteres y hasta 30 entradas. No llamar `cleanTags` del lado servidor para eliminar valores silenciosamente: rechazar una lista inválida y devolver detalles. El PATCH transmite únicamente campos modificados; un campo legacy no editado, aunque no cumpla validaciones nuevas, permanece intacto. Rating conserva dominio entero 0–255 del lector actual; name debe ser string no vacío tras trim; colores y crop usan el contrato UI inventariado en T01. Si T01 encuentra dos validadores incompatibles, STOP-DESIGN con casos concretos antes de implementar T07. En edición masiva, enviar versiones por beat y mostrar resultados/conflictos por operación; no informar éxito de toda la selección si solo se guardó una parte.

Cursor opaco validado con firma HMAC y versión; contiene tenant, epoch, revision, hash de filtros, sort y última tupla. Búsqueda determinista keyset, no OFFSET creciente. Una revisión cambiada invalida el cursor con409 y UI vuelve al primer bloque del scroll conservando filtros, sin pager; ver política stale r3. Es una semántica deliberada, sin prometer snapshot duradero entre páginas.

Consultas: índices `(user,generation,state,manual_rank,beat_id)`, equivalentes para rating/bpm/nombre y tags; LIMIT+1. `pg_trgm` para substring se incorpora solo si G0 confirma extensión disponible; de lo contrario STOP-DESIGN para fijar la alternativa, no un filtro global en JS. q de 1–2 caracteres sigue siendo válido y se mide con timeout; no prometer O(página) para todos los filtros. Respuestas y memoria sí deben estar acotadas. GET lista no selecciona legacy_json ni manifests grandes.

API nueva limita body metadata a 64 KiB, batch a 256 KiB y páginas metadata a 2 MiB como objetivos iniciales. Valores históricos mayores se conservan internamente y se detectan en T01; no truncar para alcanzar límites. Si un beat existente no cabe en el DTO previsto, STOP-DATA para diseñar detalle paginado antes de piloto.

UI conserva conflicto y datos editados, permite recargar explícitamente. No reintenta PATCH con la versión nueva automáticamente. Cambiar cuenta cancela resultados en vuelo y elimina caches con clave de otra cuenta/época. SSE puede avisar, pero el feed durable/revisión corrige eventos perdidos. Playback cache es proyección por `(user,epoch,beat,fileVersion)`, nunca autoridad.

## C6. Mutaciones SQL

PATCH: autenticar y validar antes de transacción → lock biblioteca → comprobar POSTGRES/IDLE/epoch → buscar operación/replay → comprobar versión y estado ACTIVE → aplicar patch solo a ese beat/codec/tags → version+1, revision+1, evento, presupuesto export → COMMIT → respuesta. No toca bytes de MP3 ni metadata ID3 remota.

Trash: lock/guardas iguales → comprobar ACTIVE → crear wrapper con ID único, ahora y purge_after +14 días → state TRASH, versión/evento, proyección ledger TRASH. Restaurar verifica TRASH y ausencia de purge iniciado/tombstone; cambia a ACTIVE y elimina wrapper activo. Restore no necesita reserva porque TRASH ya ocupa cuota. `purge_after` no dispara borrado automático en esta entrega.

Orden manual: importar posición estable desde array normalizado validado; nuevo beat obtiene rank menor que el mínimo bajo lock biblioteca, sin renumerar. Restore se añade al final como el flujo Web actual. No añadir reordenamiento global Web ni rename-global de tags de Desktop en esta migración. Si un consumidor Web actual los exige en T01, STOP-DESIGN con evidencia y tarea adicional.

## C7. Upload/reemplazo y resultado incierto

Estados de operación: `PREPARED → TRANSFERRING → VERIFYING → READY → COMMITTED`. Desvíos: `RECONCILE`, `CONFLICT`, `CANCELED`, `FAILED`, `BLOCKED`. Una transición solo ocurre con evidencia; guardar historial de intentos, no reemplazar errores por éxito sin prueba.

1. IMPORT crea operación/reserva en SQL y filas de archivos/partes STAGED. Comprobar cuota (active+trash+purging+pending), tombstone y Access. Reserva 15 min renovable hasta un máximo inicial de 24 h por operación. Vencimiento evita commit hasta nueva admisión, nunca borra bytes automáticamente.
2. REPLACE registra versión esperada y nuevos archivos STAGED. Mantiene visibles los anteriores; no ocupa otro beat. Metadata incluida en reemplazo se confirma junto con vínculos, nunca antes de verificar assets requeridos.
3. Por parte, persistir sender identity, chat, operationId, partKey, tamaño, hash declarado y `random_id` **antes** del envío. Pasarlo explícitamente al SDK que lo soporte. Caption lleva operationId/partKey no ambiguos; no incluir secretos.
4. Cliente envía fuera de SQL. Recibo incluye message/document IDs, sender, chat, parte y tamaño; servidor obtiene verificación de proveedor independiente del recibo del cliente. Hash declarado por cliente no es hash verificado de bytes remotos; separar ambos campos/niveles. No usar hash declarado para deduplicar o autorizar un archivo ajeno.
5. Verificador termina su lectura remota, libera recursos y guarda evidencia mediante transacción breve condicionada a epoch/lease_generation/operation. Recibo de otra cuenta/vault/parte se rechaza.
6. Commit lock biblioteca+beat; vuelve a validar versión/estado/Access/cuota/reserva y verificación de todas las partes; instala vínculos, marca anteriores RETIRED, actualiza beat+ledger+contadores+eventos+resultado atómicamente. Transacción sin red. Ante conflicto conserva nuevos objetos sin vincular para resolución/cleanup posterior; no sobrescribe la versión ganadora.
7. Caída después de commit y antes de respuesta: replay devuelve mismo resultado. Caída tras envío y antes de recibo: RECONCILE. Buscar evidencia con sender/operation/part/hash/tamaño y protocolo probado en T11; resultado inequívoco permite adoptar recibo. Cero resultados tras timeout no demuestra que no se envió; múltiples resultados → BLOCKED, no elegir ni borrar por intuición.
8. Solo reenviar cuando T11 pruebe deduplicación/reconciliación para esa identidad, SDK y sesión; en otro caso BLOCKED. Ni retry HTTP ni nuevo randomId resuelven esa incertidumbre.
9. No guardar bytes de archivos en catalog_operations. Si navegador cerró y se necesitan bytes para completar transferencia, UI pide reselección y verifica hash/tamaño antes de usar la misma parte. No marcar completado por el nombre.

PROJECT usa la ruta existente de temporal, límites Access y MASTER. T12 añade intención durable **antes** de publicar y recibo después, eliminando la transacción que hoy abarca send/verify. Ante crash no se asume que el temporal sobrevivió: RECONCILE de Telegram; si realmente falta origen y no hubo envío, pedir archivo otra vez. El garbage collector de temporales solo actúa sobre operaciones terminales o prueba de no envío. No aumentar admisión/concurrencia ni convertir PROJECT a Direct genérico.

## C8. Worker durable

Claim por `FOR UPDATE SKIP LOCKED`, lote máximo 10, lease inicial 60 s, token creciente lease_generation; COMMIT y release antes de ejecutar. Concurrencia inicial 2 global y 1 por biblioteca para efectos externos; configuración explícita. Renovar lease en transacción independiente, nunca con la conexión retenida del claim.

Todo checkpoint usa `WHERE lease_owner AND lease_generation AND epoch`; resultado de worker antiguo no confirma nada. **El fencing SQL no cancela una llamada Telegram en vuelo:** un lease vencido con dispatch incierto entra RECONCILE, no genera un segundo envío/borrado automático. Persistir dispatch antes del efecto y registrar resultado aunque llegue después como evidencia no autoritativa.

Backoff exponencial con jitter, máximo 15 minutos, obedecer FLOOD_WAIT/Retry-After aunque sea mayor. Ocho fallos transitorios → BLOCKED visible, no descartar. Errores de permisos/esquema/integridad → BLOCKED inmediato. Reinicio descubre jobs con índice por estado/fecha; no recorre todas las bibliotecas para abrir Cloud.

Readiness de catálogo requiere DB/esquema/contrato compatibles. Salud degradada de Telegram afecta transferencias, no lectura/edición de metadatos. Una biblioteca REVIEW falla cerrada para sus mutaciones; no impide servir las otras.

## C9. Purge y retención

Inicialmente `cleanup_enabled=false` y no auto-purge. Retención física propuesta: 35 días desde retiro/intención, condicionada además a ventana reversible y ventana de backups. No se habilita en real hasta C12/G4. Mayor ventana de PITR exige ampliar retención o demostrar backups de bytes y journal completo.

Purge lógico: TRASH → PURGING, operación durable y manifest de objetos/partes, bloqueo de restore, tombstone en preparación; responde 202. Materializar items en lotes si tiene muchas partes. Solo confirmar después de enumeración completa y todas las eliminaciones verificadas. Estado PURGING ocupa cuota.

Antes de eliminar un objeto: verificar bajo lock de biblioteca y después objeto (en ese orden) que no tiene vínculos actuales/retenciones/operaciones pendientes ni referencias OPAQUE sin resolver; pasar a DELETING con deletion_generation. Consultar referencias de todas las generaciones protegidas, no solo la activa. Una generación RETIRED conserva protección hasta su fecha de retención; el payload de auditoría de un PURGED no vuelve a crear un vínculo vivo. Toda nueva referencia está obligada a rechazar DELETING/DELETED. Soltar SQL; borrar y comprobar ausencia mediante lector autorizado; guardar resultado condicionado a generación. El borrado nunca depende solo de “no está en la página actual”.

Si objeto está compartido con otro beat vivo o retenido, dejar item BLOCKED y no liberar cuota en esta versión. No copiar ni borrar referencias del otro beat. La UI indica eliminación pendiente, no éxito falso. Cuando todas sus partes/objetos están confirmados: PURGED, liberar cuota una vez, conservar tombstone/journal, eliminar proyección de `library_beats` en la misma transacción.

403, timeout, chat inaccesible y error genérico de download no prueban ausencia. Incluso MESSAGE_ID_INVALID requiere contexto de chat correcto y lectura autorizada demostrada; probar tabla de errores con SDK. Un purge parcial conserva items confirmados y pendientes. El usuario no puede restaurar una entidad a la que ya se le borraron partes.

Eliminar un topic puede borrar más que un archivo: solo después de confirmar purges y ausencia de otras referencias/retenciones en el topic. Journal durable nuevo; no depender únicamente de `pendingTopicDeletes` en memoria/JSON. Cancelar cualquier cleanup antiguo durante sombra/corte que pueda afectar el snapshot o la retención.

Antes de cada eliminación física escribir evidencia inmutable fuera de la línea de restauración de DB (journal externo de borrado en el almacenamiento de backups configurado) y verificar persistencia. Si falla, no borrar. Tras restore, `restore_hold=true` hasta reconciliar ese journal y comprobar existencia/backup de referencias restauradas.

## C10. Cercado de compatibilidad

La época se comprueba en rutas HTTP, comandos internos, jobs y ejecución de helpers. No basta con que el frontend nuevo no llame métodos viejos. No aceptar ausencia de epoch como época actual para POSTGRES.

Matriz de acciones legacy sobre biblioteca POSTGRES:

| Entrada | Resultado requerido |
| --- | --- |
| index/publish, index/commit, index/bootstrap-state y creación/recovery INDEX | 410 o rechazo interno antes de Telegram; nunca repinear, crear vacío o limpiar INDEX. |
| quota/reserve/renew/cancel antiguas | 410; nuevo cliente usa reservations del catálogo. |
| routing/reconcile y routingChanges del cliente | Rechazo; rutas derivadas de vínculos actuales SQL. |
| trash/purge, delete_messages, borrado de topic antiguos | Rechazo. Exclusivo worker catálogo con operación/época válidas. |
| project/upload/authorize y topic/ensure | Solo adaptadores nuevos con operación/epoch/beat verificados; solicitud legacy rechazada antes de escribir temporal o Telegram. |
| get_index/replace_index capabilities, Worker antiguo, Desktop antiguo | Cliente incompatible; sin acceso a comando de catálogo ni bootstrap como fallback. |
| session/start y renovación de capabilities | Declaración de protocolo catalog-v1 y epoch; revisar pertenencia/permiso; no emitir acceso para un protocolo antiguo a biblioteca migrada. |
| recoverAll, migrateLegacyProjects, pin rights recovery, garbage reconciliation, startup routing | Selección por autoridad; biblioteca POSTGRES nunca se reconstruye desde INDEX. Cambios de permisos necesarios van por job independiente. |

Proteger también funciones invocables directamente y catch blocks que hoy llaman recover tras un fallo. Tests invocan rutas y helpers.

Antes de FREEZE todas las instancias Cloud/worker deben usar una versión que respete el estado persistente; apagar y verificar procesos antiguos. Un backend viejo que ya posee credenciales puede actuar sin consultar la tabla nueva. No permitir rollback del binario a uno que ignore POSTGRES; usar versión puente compatible.

T11 debe demostrar el alcance efectivo de sesiones Telegram antiguas: pin, edición, borrado de mensajes propios y ajenos, escritura con auth key previa, bot compartido entre vaults y efectos de rotación/revocación. No afirmar que quitar permisos admin impide borrar mensajes propios. Si un cliente antiguo puede destruir archivos que deben retenerse, **G2 falla**. Una inteligencia de alta capacidad debe aprobar y probar separación/revocación de identidades o transporte distinto antes de piloto. No ampliar automáticamente a rotar bots compartidos o copiar todos los medios.

## C11. Observabilidad y pruebas que definen éxito

Métricas sin secretos: latencia por ruta/kind, consulta SQL/pool wait, duración de transacciones, conexiones retenidas durante stub remoto, llamadas Telegram por operación, bytes respuesta, filas de catálogo retornadas/modificadas, conflictos, retries, operaciones RECONCILE/BLOCKED, backlog/edad jobs, errores de epoch, discrepancias de counters, restore/backup verificados. Nunca IDs de chats/tokens/captions crudos como labels públicos.

Requisitos duros: metadata GET/PATCH/trash/restore en POSTGRES = 0 llamadas Telegram/MASTER y 0 get_index/replace_index; conexión SQL de esa operación liberada al esperar transporte; cambios de metadatos independientes de N beats; una autoridad; 0 cruces de tenant; 0 pérdidas/duplicados lógicos/resurrecciones en matriz de fallos. Verificación por spies y comportamiento concurrente con PostgreSQL, no solo grep del código.

Carga de laboratorio propuesta: total 100.000 y 1.000.000 beats; distribuciones 1.000×100, 1.000×1.000 y 1×100.000; 4 tags y 3 archivos promedio, 10% trash, fixtures adicionales multipart/extremos. Perfiles con 20 clientes para metadatos y 2 transferencias concurrentes, semilla fija, recursos y versión registrados, warmup 2 min, muestreo 10 min. No se prometen millones de beats por usuario como capacidad comercial.

SLO candidato para aprobar en G0: API metadata p95 ≤250 ms/p99 ≤1 s en entorno de ensayo acordado; PATCH p95 ≤250 ms; conexión retenida durante latencia remota 0; incremento memoria para primera página de 1M frente a 100k ≤20 MiB; bytes respuesta bajo 2 MiB. Registrar latencia end-to-end por separado. 1–2 caracteres, términos frecuentes, páginas profundas, cache frío y biblioteca muy activa son perfiles obligatorios. Si no cumple, no subir presupuestos ni reducir dataset para declarar PASS: escalar resultados y EXPLAIN ANALYZE.

## C12. Decisiones de producto/operación propuestas para G0

Estas son elecciones explícitas, no huecos para que una IA pequeña elija:

| Tema | Propuesta que debe quedar aceptada antes de activar comportamiento |
| --- | --- |
| Búsqueda/orden | C12-r2 fija filtros ANY Web/exclusión exacta, búsqueda JS versionada y manual/rating. Preferencia pendiente A1: ICU und fijo con empate manual; A2: BPM total con NaN al final. lower+C se retira como opción preferente y nunca se declara equivalente. Alcance global y experiencia continua aprobados; detalles bgPage pendientes B-legacy. El plan B sustituye paginador visible por bloques internos. Ver acta, secciones3–5 y9. |
| Capacidad API | Páginas 100/240, lotes 50, límites C5. No cambiar cuotas comerciales. |
| Versiones | Una versión del beat para cualquier edición; conflicto incluso en campos distintos. No merge automático en esta entrega. |
| Retención | Mantener 14 días como dato de papelera; sin auto-purge. 35 días de retención física mínima propuesta, extensible por backups/rollback. |
| Backup de medios | Piloto solo certifica catálogo y fallos propios. Antes de prometer recuperación ante pérdida de Telegram, exigir copia íntegra verificada de todos los bytes, incluidos multipartes, y prueba de restauración. `stored` y `backup_verified` son estados distintos. |
| Rollback | Ventana propuesta de 30 días tras corte, cota export 15 MiB. No cerrar automáticamente por calendario; requiere G4 y autorización. |
| Recuperación | RPO objetivo DB ≤5 min y RTO ≤60 min, a validar con el sistema real de backups. Un objetivo no medido bloquea producción; no es un dato de AWS actual. |
| Performance | Aprobar perfil y SLO de C11 antes de medir; una excepción requiere decisión registrada. |
| Desktop | Bloqueado para bibliotecas migradas hasta un proyecto separado de compatibilidad. |

G0 puede aprobar estas propuestas en conjunto o revisarlas con un razonamiento de alta capacidad. Las partes puramente aisladas pueden prepararse, pero no se declarará el contrato final ni se habilitarán fases dependientes sin ese registro.


## Contrato del frontend LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
El catálogo PostgreSQL debe respetar las rutas `/` (Landing pública), `/gallery` (Gallery autenticada), `/login` y `/signup`; preserva redirecciones, `bgPage` antiguo y carga diferida. `preconnectRememberedWebDirect()` se invoca desde `WebGalleryWorkspace` autenticado; no reponerlo automáticamente en `src/main.tsx` solo para satisfacer tests viejos. Listas de catálogo, metadata, trash y restore lógico no necesitan Telegram; el audio/portadas y media se resuelven bajo demanda.

La Web usa inclusión **ANY** de tags, exclusión prioritaria y búsqueda insensible a mayúsculas; conservar orden `manual`/`name`/`bpm`/`rating` y desempate estable según posición manual actual (C12, propuesta no aprobada); implementar compatibilidad URL con `bgPage`/offset durante paso a cursores opacos. Mantener versiones de beat/asset, identity/owner, cachés por sesión, BeatCard de altura fija y Player funcional sin copiar la antigua UI de `main`. El resto del contrato y la semántica de INDEX legacy se preservan hasta cutover autorizado.

Ver [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md), secciones 2, 4 y 5.

### Corrección de interpretación tras G0 estático (2026-11-07)

El Web actual usa sort manual preservando el orden recibido, rating con desempate por posición manual y nombre mediante `localeCompare`. La propuesta C12 `lower(name) COLLATE "C"` es un cambio deliberado **pendiente de aprobación explícita**, no paridad demostrada. T01 debe probar Unicode, empates y cuatro sorts; T00 decide si se mantiene paridad exacta o se aprueba el cambio. Para `bgPage` antiguo frente a cursor HMAC, definir equivalencia o degradación visible y acotada; no volver a procesar INDEX entero ni paginar indefinidamente para resolver un offset profundo. Ninguna decisión C12 se da por aprobada por este documento.

## Transferencia normativa vigente C12-r4

[cierre C12-r4](C12-V00-CIERRE-20261107.md) integra las aprobaciones explícitas y sustituye pendientes/recomendaciones incompatibles r2/r3. A1 ICU fijo, A2 binary64/clase y B-legacy <=10.000 quedan aprobados. I1 selección global con aviso solo si había selección; I2 audio continuo, nuevo query y cola prioritaria, Shuffle sin repetición por ronda; I3 rename ACTIVE/TRASH sin modificar estado. Se descarta fijar permanentemente la búsqueda musical al pulsar Play.

Aplicar las dependencias, algoritmos, alternativas y STOP de sección 7 del cierre a T01/T03/T06/T07/T13/T14/T20 y V00–V11. Membresías SQL persistidas, selección CAS, facetas, journal y swaps Shuffle no son memoria global del cliente. T01/T06 deben producir inventario y contratos tipados completos en sus tareas futuras. T00 revisa formalmente base/descriptor/baseline/contrato, sin volver a solicitar las aprobaciones resueltas. T01 permanece bloqueada; ningún paso de implementación iniciado.
