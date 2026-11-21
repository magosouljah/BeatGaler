# Rediseño nativo PostgreSQL — T05 a T25 (r2.1)

Fecha: 2026-11-08. Rama `local/landing-gallery-unificada`. **Estado: PROPUESTA r2.1 pendiente de aprobación del usuario (Purp) y dictamen de Sol.** Este documento es solo plan: no implementa nada, no toca servicios reales ni datos y no ejecuta borrados.

**Prevalencia.** Una vez aprobado, este documento manda sobre T05–T25 de [TAREAS](TAREAS.md), [MATRIZ-T](MATRIZ-T-NIVELES-20261107.md), [MATRIZ-V](MATRIZ-V-NIVELES-20261107.md) (solo V08 y V11), [EJECUCION-POR-NIVELES](EJECUCION-POR-NIVELES-20261107.md) (solo los paquetes listados en §10), [MIGRACION](MIGRACION.md) y las cláusulas de [CONTRATO](CONTRATO.md) enmendadas en §9. Todo lo demás sigue vigente: C12-r4, C12-B, la Gallery infinita, V00–V11 y el diseño aprobado de Landing, Gallery, BeatCards y Playbar. T00–T04 siguen en PASS y no se reabren. No se renumeran tareas.

**Cambios r2 frente a r1** (contraste con `0026_catalog_core.sql` y el código actual):

| # | Defecto r1 | Corrección r2 |
| --- | --- | --- |
| 1 | Init insertaba la generación antes que `catalog_libraries`. `catalog_generations.user_id → catalog_libraries` no es diferible (0026:39): fallaría siempre. | Orden corregido (§3.4). |
| 2 | Generación `reset:<uuid>`. `generation_id` solo admite `[A-Za-z0-9_-]` (0026:40). | `reset-<uuid>`; el `:` va en `snapshot_id` (§4). |
| 3 | Init dentro de `GET /context`: un GET con efectos. | GET de solo lectura + `POST …/library/provision` idempotente (§3). |
| 4 | "Un binario antiguo falla cerrado". Falso para vaults reseteados: con `library_quota_state` presente, la publicación legacy no mira `index_bootstrap_pending` (`library-index-publication.js:217`). | Capa 0 en DB (0027) que bloquea escrituras legacy de cualquier binario (§5). |
| 5 | Cascadas de 0026 sin protección (R6 solo "registrado"). | Triggers 0027 de no borrado y no reasignación (§6). |
| 6 | Campos heredados sin regla nativa. | Tabla de valores obligatorios y su verificación en DB (§7). |
| 7 | T11-4 (sesiones antiguas) se aplazaba hasta usuarios reales. Los clientes Direct reciben el `bot_token` en crudo (`direct-transport-control.js:1023`), así que el cerco del servidor no los detiene. | Aislamiento por chat nuevo, revocación de capacidades y requisito de rotación o renuncia explícita antes de activar (§8). |
| 8 | El runner de migraciones no rechaza una DB con migraciones desconocidas (`postgres-migrations.js:153-166`), así que un binario viejo arranca. | Capa 0 independiente del binario y guarda de compatibilidad hacia delante en T16 (§11). |
| 9 | El reset reutilizaba el chat legacy, y el flush del control-plane revierte `telegram_chat_id` (`ON CONFLICT … SET telegram_chat_id=EXCLUDED`). | Chat nativo propio, `catalog_library_chats` y `rebind-chat` por el control-plane (§4, §6). |
| 10 | T19 dependía de T18 (eliminada); T23, de T22 (eliminada). | Dependencias reescritas (§10). |

**Cambios r2.1 frente a r2** (bloqueantes de Sol):

| # | Defecto r2 | Corrección r2.1 |
| --- | --- | --- |
| B1 | La capa 0 se presentaba como cerco. Un trigger actúa en la escritura SQL, y en `publish()` los efectos destructivos van antes: `deleteAndVerifyMessages` (`library-index-publication.js:360-365`) y `publishIndexBuffer` con repin (`:375`) se ejecutan antes de la primera escritura (`:383`). El camino `same` borra tras el COMMIT sin escribir nada (`:228-229`), `pinned()` y `quota.bootstrap()` corren antes del `BEGIN` (`:203-204`) y `cleanupPrevious` corre tras el COMMIT (`:416`). | Cerco de credenciales previo a la activación: rol DB y tokens de bot (§5.0). Capa 1 a la entrada y bajo el lock, antes de todo efecto externo. La capa 0 queda solo como defensa en profundidad del ledger. |
| B2 | Los clientes nativos seguían recibiendo `bot_token` (D-N2 abierta). | Plano de datos por gateway del servidor con capacidades acotadas; ningún cliente nativo recibe token. Impacto en rendimiento y costos en §8.6. |
| B3 | Borrar cuentas quedaba prohibido para siempre (R6). | Procedimiento controlado por estados, deshabilitado hoy (§6.1). |
| B4 | El flush todo o nada podía bloquear a todos los usuarios por un vault conflictivo. | Rechazo en origen, cuarentena por usuario y reintento acotado; el flush sigue fail-closed (§6.2). |
| B5 | §14 dejaba a Sol elegir la versión de `C12-DECISION-RECORD.md`. | C12-r4 local es la vigente y no se sustituye: `3d291d5` trae el acta remota abreviada, sin r4 (§14). |

## 1. Decisión del propietario (2026-11-08)

- No hay usuarios reales que migrar.
- Se autoriza **descartar** los INDEX, beats, metadatos y archivos de prueba existentes. **No** se autoriza todavía ejecutar borrados.
- No se importan bibliotecas antiguas: las bibliotecas nuevas nacen directamente en PostgreSQL.
- La autorización de descarte aplica solo cuando se identifica el entorno donde están esos datos (§4). No se presume.

## 2. Arquitectura final

| Capa | Rol | Lo que deja de existir |
| --- | --- | --- |
| PostgreSQL (`catalog_*`) | Única autoridad: beats, tags, papelera, tombstones, versiones de archivo, partes, ubicaciones, operaciones, reservas, jobs, eventos y cuota. | INDEX como autoridad, sombra, freeze, corte, reversión a INDEX y cota exportable de 15 MiB. |
| Telegram | Almacén de bytes en un **chat propio de la biblioteca**, que nunca contuvo un INDEX (§4). La ubicación vive en `catalog_media_objects` y `catalog_part_locations`. El caption lleva solo `operationId/partKey` (C7). | INDEX, pin, mensaje de metadata, `garbage[]`, `pendingTopicDeletes`, `get_index/replace_index`. |
| Cloud | API `/catalog/v1` (C5), worker con leases (C8) y cerco en tres capas (§5). | Bootstrap del INDEX, `recoverAll` y `migrateLegacyProjects` para vaults con catálogo. |
| Web | Con el flag nativo encendido, la Gallery lee y escribe solo por catálogo. Con el flag apagado, la app actual queda igual. | Doble modo por biblioteca en el cliente. |

Una biblioteca tiene solo tres estados para el código nuevo:

- **POSTGRES**: fila en `catalog_libraries` con `authority='POSTGRES'` y generación ACTIVE.
- **Sin aprovisionar**: no hay fila. `GET /context` → `404 LIBRARY_NOT_PROVISIONED` si el vault es certificable (§3), y si no, `409 LIBRARY_RESET_REQUIRED`.
- **LEGACY** (solo tests y staging T04): `409 LIBRARY_RESET_REQUIRED`. Nunca se lee ni se promociona.

Nunca hay fallback al modo legacy. `catalog_beats.legacy_json` se conserva como **documento canónico v2 del beat**: el nombre es histórico, y el codec de T04 lo genera y valida igual. El exportador de T04 queda como export lógico y portable (§11). El importador queda inactivo: ninguna ruta lo invoca.

## 3. Aprovisionamiento atómico e idempotente

### 3.1 Activación del entorno (una vez, con autorización)

`T17-N activate` inserta la única fila de `catalog_native_activation` (0027): `environment_id` (PK), `activated_at`, `run_id`, los `transport_bot_ids` permitidos y `direct_token_exposure` (`ROTATED` o `FRESH_BOTS`, §5.0). Es idempotente: con el mismo `environment_id` y manifiesto, no-op. Con otro, se niega.

Precondiciones de `activate`, verificadas en la misma transacción:

- `inspect` aprobado (§4.1);
- el control-plane está en modo `postgres` y el estado JSON-compat coincide con SQL en número y hash de users y vaults, sin vaults pendientes de volcar;
- no hay filas en `catalog_libraries`, salvo staging T04 marcado en el manifiesto;
- el cerco de credenciales de §5.0 está completo y verificado: no basta con declararlo.

### 3.2 Marca positiva en el vault (0027)

Columna `vaults.catalog_native_eligible boolean NOT NULL DEFAULT false` y trigger `BEFORE INSERT ON vaults` que la pone en `true` solo si existe activación. Los vaults existentes quedan en `false`.

En `INSERT … ON CONFLICT(user_id) DO UPDATE` (las tres rutas de upsert: `postgres-control-plane-runtime.js:207`, `postgres-auth-multiprocess-compat.js:117`, `legacy-import-executor.js:175`) el trigger ve la fila propuesta, pero en conflicto solo se aplica el `SET`, que no incluye la columna. Así, un vault existente sigue en `false`. T05 lo prueba.

`index_bootstrap_pending` **no** es prueba de nativo: las tres rutas lo ponen en `true` en todo INSERT nuevo. Solo cuenta junto con la marca.

### 3.3 Lectura y aprovisionamiento

- `GET /catalog/v1/context` → `resolveContext()` en `catalog/authority.js`. **Nunca escribe.** Devuelve el contexto, `404 LIBRARY_NOT_PROVISIONED`, `409 LIBRARY_RESET_REQUIRED` o 503.
- `POST /catalog/v1/library/provision` → `provisionLibrary()`. Es idempotente por clave natural `user_id` (PK de `catalog_libraries`): si la fila POSTGRES ya existe, devuelve `200 {created:false}` con la misma era y generación, sin escribir. No necesita idempotency-key.
- El cliente (T08) llama a provision solo tras recibir 404, una vez. Los demás estados no se aprovisionan.

### 3.4 `provisionLibrary()`: una transacción, sin red

1. Autenticación server-side → `users.id` (C1.1). Se exigen control-plane `postgres`, PG disponible, `BEATGALER_CATALOG_NATIVE_ENABLED=true` y la fila de activación. Si falta algo: 503 `CATALOG_UNAVAILABLE`.
2. `BEGIN` → `SELECT … FROM vaults WHERE user_id=$1 FOR UPDATE`. Es el mismo lock que toma la publicación legacy (`library-index-publication.js:211`).
3. Si ya existe la fila: POSTGRES → retorno idempotente; LEGACY → `409 RESET_REQUIRED`.
4. **Predicado nativo**, todo en SQL:
   - `catalog_native_eligible = true` y `index_bootstrap_pending = true`;
   - el `telegram_chat_id` del vault no está en `catalog_library_chats`, de ningún usuario;
   - sin filas del usuario o del vault en `vault_index_pointers`, `library_quota_state`, `library_beats`, `library_trash_purges`, `library_beat_reservations`, `library_project_uploads`, `library_legacy_project_copies`, pin authority (0016), `garbage_journal`, `direct_operations` no terminales ni `direct_capabilities` de tipo INDEX. T05-A cierra la lista exacta desde el consumer-map, con path:línea.
5. Si se cumple, en este orden:
   1. `INSERT catalog_libraries` con `authority='POSTGRES'` **explícito** (el default de 0026 es LEGACY), `migration_state='IDLE'`, era nueva, época 1, `active_generation_id='native-<uuid>'`, contadores en 0, `cleanup_enabled=false` y `restore_hold=true`. La FK a la generación es `DEFERRABLE INITIALLY DEFERRED` (0026:57-60) y el CHECK `postgres_needs_generation` se cumple.
   2. `INSERT catalog_generations` con `native-<uuid>` directamente ACTIVE, `origin='NATIVE'` (0027), `snapshot_id='native:<uuid>'`, `raw_index` NULL, `source_hash` = SHA-256 del descriptor canónico vacío y `validated_at=now()`. 0026 lo permite: el trigger de transición es solo `BEFORE UPDATE`.
   3. `INSERT catalog_library_chats(provider, chat_id, user_id, vault_id, state='CURRENT')`.
   4. `UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason='CATALOG_NATIVE'` para las vivas del usuario (§8).
   5. `UPDATE vaults SET index_bootstrap_pending=false` → COMMIT.
6. Si no se cumple: ROLLBACK, `409 LIBRARY_RESET_REQUIRED` y 0 escrituras. Nunca se crea una biblioteca vacía por inferencia (C1.3).

### 3.5 Por qué es seguro

- **Concurrencia:** dos provisiones se serializan en el lock del vault y la segunda ve la fila. La PK `user_id` y el índice único de generación ACTIVE (0026:55) son el respaldo si alguien se salta el lock.
- **Publicación legacy concurrente:** también se serializa. Si gana, deja puntero o ledger, el predicado falla y la respuesta es RESET_REQUIRED.
- **Vacío por error:** exige marca escrita por la DB tras la activación, chat nunca registrado y cero rastros legacy. El estado JSON en sincronía (§3.1) evita que un vault de la era JSON entre después como nuevo. El re-cutover queda bloqueado (§12).
- **Orden de locks:** `vaults` (solo provision, reset y rebind) → `catalog_libraries` → el orden C1.6. Nada bloquea `vaults` después de `catalog_libraries`.

## 4. Datos de prueba existentes: inventario, reset y chats

### 4.1 `T17-N inspect` (solo lectura, autorización por entorno)

Corre en `SET TRANSACTION READ ONLY` con un rol sin permisos de escritura. Por vault reporta:

- puntero o pin, `library_beats`, cuota y purges;
- operaciones Direct y PROJECT en vuelo y capacidades vivas;
- chat, bot asignado y divergencias de `vaults.id` entre JSON y SQL (el upsert por `user_id` no actualiza `id`).

Telegram solo se consulta si se autoriza aparte. El resultado es un manifiesto con hash por vault. **El propietario marca cuáles son descartables.** Sin inventario marcado no hay reset.

### 4.2 `T17-N reset` (dry-run por defecto)

`--apply` exige un manifiesto con entorno, vault, hash de inventario, el chat nuevo y la aprobación. En una sola transacción, con el vault bloqueado:

1. Recalcula el hash de inventario bajo el lock. Si difiere del manifiesto: STOP-DATA, sin escribir (TOCTOU).
2. Si hay operaciones legacy en vuelo: STOP.
3. Si ya existe fila **POSTGRES**: si su generación `reset-` registra el mismo hash de manifiesto, no-op `ALREADY_APPLIED`; si no, `LIBRARY_ALREADY_NATIVE` (STOP-DATA). **Un reset nunca vacía una biblioteca nativa.**
4. Exige que el vault ya apunte a un **chat nuevo** que no esté en `catalog_library_chats`, con el cambio hecho por `rebind-chat` (§4.3). El chat legacy queda en `catalog_library_chats` como `LEGACY_ABANDONED`: el worker nativo nunca escribe ni borra en él.
5. Si hay fila LEGACY (staging T04): sus generaciones pasan a RETIRED por transiciones permitidas, sin DELETE. Primero RETIRED (el índice único ACTIVE no es diferible), luego INSERT de la generación nueva y luego `UPDATE` de la biblioteca a POSTGRES, con era nueva y `época+1`. Sin fila: INSERT como en §3.4.
6. La generación nueva es `reset-<uuid>`, con `origin='RESET'`, `snapshot_id='reset:<uuid>'` y un `descriptor_json` canónico con lo abandonado: chat legacy, puntero, hash del ledger, conteos y hash del manifiesto.
7. Revoca las capacidades Direct vivas y pone `index_bootstrap_pending=false`.

**Qué no hace:** no borra filas legacy, que quedan inertes e inescribibles por la capa 0 (§5), ni medios ni INDEX en Telegram. Esos quedan en el chat abandonado: una fuga, no una pérdida. Su eliminación es T24-N, opcional y con autorización propia, y se hace **por chat abandonado completo**, sin mezclar nunca mensajes nativos.

### 4.3 `T17-N rebind-chat` (dry-run por defecto)

Es la única vía para cambiar `vaults.telegram_chat_id` de un vault con catálogo o en reset. Escribe por la **ruta de escritura del control-plane** y no por SQL directo, para que el estado JSON-compat y SQL coincidan y el siguiente flush no revierta el chat. Abre la ventana con una fila en `catalog_chat_rebinds` (0027) que el trigger de §6 reconoce.

En una biblioteca POSTGRES, el chat anterior pasa a `RETIRED`: solo lectura para acceso a medios existentes y sin subidas nuevas. Las ubicaciones guardan su propio `chat_id` y no se reescriben.

### 4.4 Vault no reseteado

En un entorno activado responde RESET_REQUIRED y Web muestra el estado de error existente. No se crea UI nueva. Si hace falta cambiar copy o componentes: STOP-DESIGN.

## 5. Cerco

**Principio:** un actor antiguo se cerca quitándole las credenciales, no detectando sus escrituras. Ningún trigger puede deshacer un borrado o un repin en Telegram hechos antes del COMMIT.

### 5.0 Cerco de credenciales (antes de `activate`, con autorización por entorno)

Pasos en orden. Cada uno se verifica antes de pasar al siguiente, y `activate` (§3.1) comprueba la evidencia de todos.

1. **Drenaje:** se despliega el candidato y se paran todas las instancias Cloud y workers anteriores a T05. Se registra el inventario de instancias.
2. **Rol DB nuevo:** el candidato usa un rol nuevo (`beatgaler_catalog_rt`). El rol antiguo pasa a `NOLOGIN` y se terminan sus backends (`pg_terminate_backend`). Un binario antiguo superviviente no puede ejecutar SQL. Si estaba en mitad de `publish()`, su transacción aborta, y lo que ya hubiera enviado solo afecta al chat legacy (punto 4).
3. **Tokens de bot:** se revoca el token de cada bot en `transport_bot_ids` y el nuevo se guarda en un `secret_ref` **nuevo**, legible solo por la identidad de runtime del candidato. Así, un proceso antiguo que relea su `secret_ref` no obtiene el token nuevo. Toda instalación Direct, binario o pestaña con el token viejo pierde el acceso a Telegram. Alternativa equivalente: bots nuevos que nunca emitieron un token. Valores de `direct_token_exposure`: `ROTATED` o `FRESH_BOTS`. **Se elimina `WAIVED_TEST_ONLY`.** T11 verifica en el sandbox que revocar el token invalida las sesiones Bot API y MTProto ya abiertas. Si no las invalida: STOP-INTEGRITY.
4. **Separación de chats:** el chat nativo nunca tuvo INDEX ni ids conocidos por el legacy (§4). Cualquier efecto residual de un actor antiguo, como `cleanupPrevious` tras el COMMIT, el borrado del camino `same` o el `deleteMessages(orphanId)` de `:149`, cae solo en chats `LEGACY_ABANDONED`.

### 5.1 Capas en el código nuevo

**Capa 1, por vault, en Cloud, siempre activa (también con el flag apagado).** Si el dueño tiene fila de catálogo, toda entrada C10 se rechaza **antes del primer efecto externo**, ya sea lectura o escritura en Telegram, temporales o SQL legacy, y se vuelve a comprobar bajo el lock del vault antes del primer efecto dentro de la transacción. En `library-index-publication.js` hay tres puntos obligatorios:

- la entrada de `publish`, antes de `:203`, que cubre `pinned`, `bootstrap` y el camino `same`;
- tras `FOR UPDATE` en `:211`, antes de `pinned` (`:216`), `deleteAndVerifyMessages` (`:364`) y `publishIndexBuffer` (`:375`);
- la entrada de `purgeTrash`, recover y `bootstrapState`.

**Capa 0, en DB (0027): defensa en profundidad, no cerco.** Impide que el ledger legacy de una biblioteca nativa se corrompa por un error del código nuevo. No protege contra efectos en Telegram. Triggers `BEFORE INSERT OR UPDATE OR DELETE` que lanzan `CATALOG_LEGACY_WRITE_FORBIDDEN` (SQLSTATE propio) si el usuario tiene una biblioteca POSTGRES, sobre:

- `vault_index_pointers`, `library_quota_state`, `library_beats`, `library_trash_purges`, `library_beat_reservations` y `library_project_uploads`;
- `garbage_journal` y la tabla de pin authority 0016;
- INSERT en `direct_capabilities` y `direct_operations` con tipo `get_index`, `replace_index` o `delete_messages`.

Entradas C10 de la capa 1:

- `index/publish|commit|bootstrap-state`, `quota/*`, `trash/purge`, `delete_messages` y borrado de topic;
- `routing/reconcile`, `project/upload/authorize` legacy, `topic/ensure` legacy y emisión de `get_index/replace_index`;
- `recover`, `ensureBootstrap`, `cleanupPrevious` y los catch que llaman a recover.

HTTP responde `410 LEGACY_CLIENT_UNSUPPORTED`; los helpers, un error tipado. Se prueba por rutas **y** por helpers directos (C10).

**Capa 2, por entorno, con el flag encendido:**

- no se crea ningún INDEX nuevo;
- `session/start` sin protocolo `catalog-v1` se rechaza;
- `ensureAll`, `recoverAll` y `migrateLegacyProjects` saltan los vaults con catálogo (`server.js:84-85`).

Apagar el flag es un **interruptor de emergencia no destructivo**: las capas 0 y 1 siguen activas, y el cerco de credenciales no se deshace. La app legacy no puede usar ni dañar la biblioteca nativa. T16 lo demuestra.

## 6. Cascadas y reasignaciones: protección en DB (0027)

0026 no se modifica. 0027 añade solo triggers y tablas. **Toda guarda se activa solo si existe la fila de activación o la generación tiene `origin` NATIVE o RESET**, así T03/T04 (que aplican todas las migraciones y hacen LEGACY→POSTGRES y DELETE de bibliotecas LEGACY, `catalog-schema.integration.cjs:94,114`) siguen intactos por construcción.

| Riesgo en 0026 | Guarda 0027 |
| --- | --- |
| `DELETE users` o `vaults` → cascada a `catalog_libraries` (0026:12, 33) → generaciones, beats, tombstones y `catalog_media_objects` (0026:273). Se pierde el único mapa de mensajes Telegram y quedan huérfanos sin journal. | `BEFORE DELETE ON catalog_libraries` para filas POSTGRES: rechaza **salvo** que exista en `catalog_account_deletions` una fila del usuario en `MEDIA_DELETED` y la sesión lleve `beatgaler.account_deletion_id` igual a ese id (§6.1). La cascada desde `users` o `vaults` ejecuta este trigger. Hoy no existe `DELETE FROM users/vaults` productivo; el flush solo borra sesiones, providers y MFA (`postgres-auth-multiprocess-compat.js:76-105`). |
| `TRUNCATE` no ejecuta triggers de fila. | `BEFORE TRUNCATE` de sentencia en `users`, `vaults` y las `catalog_*` raíz: rechaza si hay activación. |
| `DELETE catalog_generations` → cascada a beats, ficheros, tombstones y query sets. | Generación NATIVE o RESET: DELETE solo si está RETIRED y fuera de la retención C9. Nunca la ACTIVE. |
| `DELETE catalog_media_objects` pierde el localizador físico. | Biblioteca POSTGRES: solo si `status='DELETED'`, que escribe el worker tras el borrado con journal (C9). |
| `UPDATE vaults.telegram_chat_id`, `id` o `user_id` por flush o snapshot. | `BEFORE UPDATE OF telegram_chat_id, id, user_id ON vaults` con biblioteca POSTGRES: rechaza salvo una fila abierta en `catalog_chat_rebinds` (§4.3). |
| `UPDATE catalog_libraries` POSTGRES→LEGACY o `migration_state≠IDLE`. | Rechaza si hay activación. **No existe retorno a INDEX.** |
| INSERT LEGACY tras la activación (p. ej. `repository.createLibrary`, `catalog/repository.js:19`). | Rechaza si hay activación. |
| `catalog_media_objects` único por `(user_id, chat, message)` (0026:285), no global. | INSERT de una biblioteca POSTGRES solo si `chat_id` está `CURRENT` para ese usuario en `catalog_library_chats` (PK global `provider, chat_id`). Un chat pertenece a una sola biblioteca, para siempre. |

### 6.1 Borrado de cuenta controlado (diseñado, deshabilitado)

Hoy no se puede borrar ninguna cuenta. 0027 crea solo la tabla `catalog_account_deletions` y la excepción del trigger. No existe código que inserte filas ni que avance estados, y el flag `BEATGALER_ACCOUNT_DELETION_ENABLED=false` no se puede encender sin una tarea propia (implementación en T15, habilitación en T24, cada una con autorización separada).

Estados, que solo avanzan y quedan auditados:

1. **REQUESTED:** pedido por el titular autenticado, con reautenticación (MFA si la tiene), o por el operador con un manifiesto firmado.
2. **COOLING_OFF:** periodo cancelable, cuya duración fija el propietario. Durante ese tiempo la biblioteca sigue intacta.
3. **FROZEN:** en una sola transacción, la biblioteca pasa a solo lectura, `época+1`, se revocan sesiones y capacidades y se cancelan operaciones y jobs.
4. **PURGING:** el worker C9 borra cada `catalog_media_objects` con journal externo previo. Si el chat es exclusivo de la biblioteca, se puede vaciar entero con autorización propia. Respeta `restore_hold` y la retención.
5. **MEDIA_DELETED:** todos los objetos están en `DELETED` y verificados. Sin eso no hay paso siguiente.
6. **DB_DELETED:** el job abre una sesión con `beatgaler.account_deletion_id`, borra `users` y la cascada pasa el trigger. La fila de `catalog_account_deletions` se conserva sin FK, como evidencia mínima sin datos de catálogo.

**Límite declarado:** los backups dentro de la ventana de retención siguen conteniendo la cuenta hasta que caducan. El restore de un backup anterior al borrado debe volver a aplicar el journal de borrados de cuenta antes de liberar `restore_hold` (T19). Los plazos legales de supresión los fija el propietario.

### 6.2 Flush del control-plane: fail-closed sin bloqueo global

Los upserts de vaults van en una sola transacción, todo o nada. Para que un vault conflictivo no bloquee al resto:

1. **Rechazo en origen:** la ruta del control-plane que cambia el chat o el id de un vault rechaza el cambio, con `CATALOG_VAULT_REBIND_FORBIDDEN`, si el vault tiene biblioteca POSTGRES y no hay un `rebind-chat` abierto. El cambio no llega al estado JSON-compat.
2. **Cuarentena por usuario:** antes de `BEGIN`, el flusher compara el delta con SQL. Las filas de vaults nativos en conflicto salen de la transacción y quedan en `control_plane_flush_quarantine` (0027) con usuario, campo, hash del valor y fechas de detección. El resto de usuarios hace COMMIT. La base del delta **no avanza** para las filas en cuarentena, así que se reintentan en cada flush sin perderse.
3. **Fail-closed por usuario:** un usuario en cuarentena recibe `409 VAULT_QUARANTINED` en el catálogo y en las escrituras de vault del control-plane, y el legacy ya está cercado. Nadie usa un valor dudoso.
4. **Respaldo del trigger:** si la pre-comprobación falla y salta el trigger de §6, el error trae el `user_id` en `DETAIL`. El flusher pone ese usuario en cuarentena y reintenta **una sola vez** sin él. Si vuelve a fallar, o si la cuarentena supera N usuarios (umbral en T16), el flush entero se detiene, salta una alerta y se registra STOP-ENV. Así el bloqueo global solo ocurre ante un fallo sistémico.
5. **Resolución, nunca automática a favor del valor nuevo:** o `rebind-chat` autorizado, o la reversión del valor JSON-compat al de SQL con un evento de auditoría (para vaults nativos, la vinculación del catálogo prevalece). Cada cuarentena tiene un dueño y una alerta de antigüedad, así que no queda en silencio indefinidamente.

## 7. Campos heredados de 0026: valores nativos obligatorios

Las reglas marcadas con **DB** se verifican con triggers 0027, limitados a generaciones de `origin` NATIVE o RESET. Las demás se aplican en el código y se prueban.

| Campo | Regla nativa |
| --- | --- |
| `catalog_libraries.authority` | `POSTGRES` explícito en el INSERT. **DB:** LEGACY prohibido con activación. |
| `migration_state` | Siempre `IDLE`. **DB.** SHADOW, FREEZING, FROZEN, ROLLBACK y REVIEW quedan sin uso. |
| `authority_era/epoch` | Era nueva al nacer; `época+1` en reset desde LEGACY, en rebind y en restore (§11). |
| `export_bytes_estimate`, `rollback_max_bytes` | Inertes: nunca se leen para decidir (C4 enmendada). Se dejan en default. |
| `restore_hold` | Nace `true`. Solo se libera en T15 o T24, con el journal externo reconciliado (vacío para una biblioteca nueva) y `cleanup_enabled` aprobado. |
| `catalog_generations.origin` (nueva, 0027) | `LEGACY_IMPORT` por defecto (T03/T04), `NATIVE` o `RESET`. **DB:** inmutable. |
| `raw_index`, `raw_index_sha256` | NULL. **DB.** |
| `catalog_legacy_fields` | Sin filas. **DB.** |
| `catalog_beats.beat_id` | Generado por el servidor dentro de `^[A-Za-z0-9._:@+-]{1,192}$`, así que `direct_scope_compatible` siempre es true. **DB.** |
| `legacy_json`, `legacy_sha256`, `legacy_export_bytes`, `legacy_presence` | Documento canónico v2 del codec T04; `legacy_presence='{}'`; bytes calculados por el codec. |
| `manual_rank`, `sort_order` | Asignación de T07 bajo el lock de la biblioteca. |
| `catalog_file_versions.role` | No se usan `LEGACY_OTHER` ni `METADATA`. **DB.** |
| `legacy_path` (NOT NULL) | Ruta canónica que el codec emite para el slot; nunca texto libre. |
| `catalog_current_files.slot_key` | No se usa `METADATA`. **DB.** |
| `catalog_trash_entries` | `wrapper_present=true`; `export_position` monótono por generación bajo el lock (T07). |
| `catalog_tombstones` | `source='CATALOG'`, con `original_json`, `raw_key`, `export_position` y `sql_state` en NULL (lo exigen los CHECK de 0026:211-212). **DB:** solo CATALOG. |
| `catalog_media_objects.status` | `PRESENT` solo tras la verificación del proveedor. Nunca `UNKNOWN` en nativo. |
| `library_beats`, `library_quota_state` | Nunca se escriben (C1.9 enmendada); capa 0. |

## 8. Aislamiento de clientes, credenciales y sesiones antiguas

**Hecho:** al iniciar Direct, el servidor entrega `bot_token`, `api_id` y `api_hash` al cliente (`direct-transport-control.js:1015-1030`, modo `telegram-direct-botapi-local`). Desktop corre un Bot API local y Web usa MTProto (mtcute). Toda instalación que alguna vez tuvo sesión Direct puede llamar a Telegram por su cuenta (borrar, pin, editar) en cualquier chat donde ese bot sea admin, mientras el token no se rote. Las capas 0–2 no lo impiden. Hoy los bytes van directo cliente↔Telegram y Cloud no transporta media.

**Reglas:**

1. **Chat nuevo por biblioteca** (§4). Un cliente antiguo no conoce los `message_id` nativos ni tiene un INDEX que apunte a ellos. Sus rutinas automáticas (`garbage[]`, `cleanupPrevious`) solo operan sobre ids del chat abandonado.
2. **Revocación en la misma transacción** de provision o reset: capacidades vivas → REVOKED. La capa 2 rechaza `session/start` sin `catalog-v1`, y la capa 0, la emisión de capacidades INDEX.
3. **Token de bot:** rotación o bots nuevos, obligatorio (§5.0). No hay renuncia posible.
4. **Por entorno:** bots y chats propios. La activación fija `transport_bot_ids`, y un vault nativo asignado a un bot fuera de la lista no se aprovisiona.
5. **Ningún cliente nativo recibe `bot_token`, `api_id` ni `api_hash`** (§8.6). La respuesta `session/start` con `catalog-v1` no lleva credenciales de Telegram. Un test lo verifica sobre el JSON serializado.

### 8.6 Plano de datos nativo: gateway de medios

**Diseño.** Las credenciales de Telegram viven solo en un gateway de servidor: un proceso Cloud o un servicio aparte con un Bot API autoalojado o MTProto, sobre el pool `transport_bots` y sus leases. El cliente obtiene de `/catalog/v1` una **capacidad de transferencia**:

- opaca, de vida corta (minutos), de un solo uso para subidas;
- ligada a la sesión, al usuario, a `operationId/partKey` o `fileId/part` y a la dirección;
- se guarda solo su hash, igual que `direct_capabilities`.

Con ella, el cliente sube o descarga por HTTP en streaming, con `Range` en las descargas. El gateway hace el envío C7 (`random_id`, recibo, verificación del proveedor) y nunca expone ids de chat ni de mensaje. Un cliente malicioso solo puede transferir lo que su capacidad nombra: borrar, editar o tocar otros chats queda fuera de su alcance.

**Alternativas descartadas:**

- token por usuario o por chat: sigue siendo un token crudo y el radio de daño es igual de grande dentro del chat;
- MTProto de usuario en el cliente: credencial todavía más amplia;
- URLs de descarga directa de Telegram: llevan el token en la ruta.

**Impacto en rendimiento.** Hoy los bytes no pasan por Cloud. Con el gateway, cada byte pasa una vez por el servidor:

- **Latencia:** un salto más. Afecta al tiempo hasta el primer byte del playback y al seek. Objetivo en T20: p95 del primer byte de audio y de seek ≤ referencia Direct actual + 150 ms en LAN-LAB, a confirmar por Sol.
- **Throughput:** limitado por la red del gateway y por los límites por bot de Telegram (FLOOD_WAIT). Concentrar a todos los usuarios en pocos bots obliga a repartir sobre el pool y a limitar concurrencia por usuario.
- **Memoria:** acotada por tamaño de chunk × transferencias concurrentes. Sin buffer de fichero completo.
- **Caché:** artwork y previews en la caché del gateway, con URLs privadas firmadas de vida corta. Reduce el egress repetido.

**Impacto en costos.** Coste nuevo dominado por el egress:

- egress mensual ≈ GB descargados por clientes + GB subidos a Telegram (normalmente el ingress no se cobra);
- orden de magnitud con tarifas de lista de nube pública (~0,09 USD/GB, a verificar con la tarifa y la región vigentes): 1 TB/mes ≈ 90 USD/mes, más el cómputo del gateway (instancias pequeñas, porque el streaming consume poca CPU);
- el egress se puede reducir con caché y con un CDN privado para artwork.

T20 mide GB por usuario activo y coste por GB reales. El presupuesto mensual es la decisión **D-N6** del propietario antes de T21.

**Tareas afectadas:**

- T11: el contrato de envío pasa a ejecutarse en el gateway.
- T12 y T14: transferencias, PROJECT, playback y descargas por capacidad.
- T16: la respuesta de sesión no lleva credenciales.
- T20: latencia, throughput y costo del gateway.

Direct legacy con token sigue igual solo para vaults sin catálogo, en entornos no activados, hasta T25.

## 9. Enmiendas al contrato

| Cláusula | Enmienda |
| --- | --- |
| C1.2–C1.4 | En un entorno activado, la única autoridad del código nuevo es POSTGRES. Sin fila: 404 → provision (§3) o RESET_REQUIRED. LEGACY → RESET_REQUIRED. Nunca hay fallback. |
| C1.9 | Las bibliotecas nativas no escriben `library_beats` ni `library_quota_state`; la capa 0 lo impone. La cuota sale de los contadores de `catalog_libraries` bajo su lock. Verificado: `library-beat-quota.js` solo se importa en `library-index-publication.js` y `library-trash-assets.js`. |
| C1 flags | Nuevo `BEATGALER_CATALOG_NATIVE_ENABLED=false`, por entorno. No elige autoridad por biblioteca. |
| C3 | 0026 sin cambios. 0027 aditiva y sin jsonb (guard D-08, `postgres-migrations.js:126`). Contiene: `catalog_native_activation`, `vaults.catalog_native_eligible` con su trigger, `catalog_generations.origin`, `catalog_library_chats`, `catalog_chat_rebinds`, `catalog_account_deletions`, `control_plane_flush_quarantine` y los triggers de §5.1 (capa 0), §6 y §7. Ninguna guarda actúa sin activación ni `origin` nativo. `catalog_migration_runs` queda sin objeto. |
| C4 | Importador inactivo. Export autoritativo como backup lógico y portabilidad. No aplican `rollback_max_bytes` ni `ROLLBACK_CAPACITY_EXCEEDED`. |
| C5 | `GET /context` sin efectos; nuevo `POST /library/provision` idempotente. Nuevos códigos: `404 LIBRARY_NOT_PROVISIONED`, `409 LIBRARY_RESET_REQUIRED`, `410 LEGACY_CLIENT_UNSUPPORTED` y `503 CATALOG_UNAVAILABLE`. `context.authority` siempre es POSTGRES. |
| C7, C8 | Sin cambios de semántica: no se publica INDEX, las subidas van al chat `CURRENT` y el envío lo ejecuta el gateway (§8.6), nunca un cliente con token. Capacidades de transferencia de vida corta y acotadas. |
| C9 | La retención de 35 días se ancla a la ventana de backups. Tombstones `source='CATALOG'`. Sin unión con `INDEX.deleted` ni `garbage[]`. `restore_hold` según §7. El worker nunca toca chats `LEGACY_ABANDONED`. |
| C10 | Capas 0, 1 y 2 (§5). |
| C12 | La fila *Rollback* queda sin objeto. La recuperación es restore de PG (§11) más el interruptor no destructivo. |
| MIGRACION | M0–M6, R1 y R2 quedan sin objeto. R3 (restaurar sin resucitar referencias) pasa a T19. Los sustituyen `inspect`, `activate`, `reset` y `rebind-chat` (§3–§4). |

## 10. Disposición de tareas y dependencias (sin renumerar)

| T | Disposición | Contenido resultante | Depende de | Nivel N1 |
| --- | --- | --- | --- | --- |
| T00–T04 | PASS, intactas | Codec y export T04 reutilizados; importador inactivo. | — | — |
| **T05** | **REDEFINIDA** | `resolveContext`, `provisionLibrary`, era y época, 0027 completa, capa 0, capa 1, guardas JSON (§12). | T04 PASS, r2.1 aprobada, reconciliación Git (§14) | MEDIA (A, C) + BAJA (B) |
| T06 | Conservada | Consultas, cursores y endpoints; monta `/context` y `/library/provision`. `bgPage` legacy se mantiene (R9). | T05 + C12 | ALTA localizada + MEDIA |
| T07 | Simplificada | Sin presupuesto exportable ni proyección `library_beats`; `export_position` y `manual_rank` nativos. | T06 | MEDIA |
| T08 | Simplificada | Con el flag, solo catálogo; 404 → provision una vez; RESET_REQUIRED con el error existente. | T07, V01/V02 | MEDIA |
| T09 | Simplificada | Sin ledger legacy ni bootstrap desde INDEX; cuota de contadores. | T08 | MEDIA |
| T10 | Conservada | Worker con leases. | T09 | MEDIA |
| T11 | Modificada | Envío, recibo, reconcile y `random_id` (pasos 1–3 y 5) **en el gateway** (§8.6). El paso 4 pasa a verificar que la revocación del token invalida las sesiones Bot API y MTProto abiertas (§5.0.3). Es requisito de activación, sin renuncia. | T10 + sandbox autorizado | ALTA |
| T12 | Conservada | Transferencias y PROJECT a operaciones, sin INDEX, por capacidades del gateway. | T11 PASS | MEDIA |
| T13 | Simplificada | Mutaciones solo por catálogo; sin metadata message; strip ID3 conservado. | T12, V00-A/B, V04 | MEDIA |
| T14 | Conservada | Playback, artwork y descargas desde SQL por el gateway con `Range`, incluido el acceso a chats `RETIRED`. | T13, V04, T06 | MEDIA |
| T15 | Simplificada | Purge solo desde SQL y solo en chats `CURRENT` o `RETIRED`; journal externo conservado; liberación de `restore_hold`; implementación de §6.1 con el flag apagado. | T14 | MEDIA |
| T16 | Simplificada | Capa 2 en `server.js`, orden de middleware, interruptor no destructivo, guarda de compatibilidad hacia delante (§11), V08 simplificada y V09. La prueba de dos bibliotecas pasa a: nativa + RESET_REQUIRED + flag apagado. | T15, V05/V06/V07 | MEDIA |
| **T17** | **REDEFINIDA** | CLI nativa: `inspect`, `activate`, `reset`, `rebind-chat` y `--help`, todas en dry-run por defecto salvo `inspect`. Sin sombra, freeze, corte ni reversión. | T16 | MEDIA (A) + BAJA (B) |
| T18 | **Eliminada (sin objeto)** | No hay migración ni rollback a INDEX. | — | — |
| T19 | Conservada (refuerzo) | Backup y restore PG con journal: **única** vía de recuperación (§11). Incluye R3 y el export lógico de bibliotecas nativas, con tombstones CATALOG. | **T17** (antes T18) | MEDIA |
| T20 | Conservada (ampliada) | Capacidad y latencia (C11), más latencia, throughput y costo por GB del gateway (§8.6). | T19, V09 | BAJA + MEDIA |
| T21 | Conservada | Candidato y revisión ALTA. | T20, G2-N, G3 | ALTA |
| T22 | **Eliminada (sin objeto)** | No hay sombra ni import. | — | — |
| **T23** | **REDEFINIDA** | Activación en un entorno autorizado: desplegar el candidato, `inspect`, cerco de credenciales §5.0 verificado, `rebind-chat` y `reset` de los vaults marcados, `activate`, smoke con una biblioteca nueva y observación. | **T21**, G0–G4-N + permiso de activación (antes T22) | MEDIA |
| T24 | Simplificada | Sin cohortes. `cleanup_enabled` por biblioteca; opcionalmente, vaciar chats `LEGACY_ABANDONED` completos y habilitar §6.1, cada cosa con autorización separada. | T23 + permiso de cleanup | BAJA + MEDIA |
| T25 | Simplificada | Retirar el código INDEX/legacy cuando ningún entorno lo use. Las capas 0 y 1 (410) se quedan permanentes. | T24 + permiso | BAJA + MEDIA |

**N1 que dejan de aplicar:**

- MATRIZ-T: T17 "MEDIA checkpoints" (sombra, freeze), T18 completa, T22 completa, el runbook de cohortes de T24 y el "cerrar reversibilidad" de T25.
- MATRIZ-V: V11-B (sombra en T22) queda sin objeto. V11-C pasa a smoke de activación en T23. V08 "composición por autoridad" pasa a composición por flag de entorno. V00–V07, V09 y V10 sin cambios.
- EJECUCION-POR-NIVELES: los paquetes de los puntos anteriores. No se renumera nada.

**Resultado:** 2 eliminadas (T18, T22), 3 redefinidas (T05, T17, T23), 9 simplificadas y 7 conservadas.

**Orden:** T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T19 → T20 → T21 → T23 → T24 → T25. Una sola tarea por encargo y PASS solo con evidencia.

## 11. Recuperación PostgreSQL y compatibilidad de software (sin INDEX)

- **Única vía:** backup físico o PITR de PG (T19), restaurado en una instancia aislada con workers apagados, `restore_hold=true` en todas las bibliotecas, `época+1` en todas (invalida clientes, cursores y dispatch en vuelo) y reconciliación del journal externo de purges antes de liberar nada (C9).
- **Punto de restore permitido:** solo posterior al COMMIT de la activación y con 0027 aplicada. Restaurar a antes de la activación devolvería `index_bootstrap_pending=true` y quitaría la capa 0 en chats con medios nativos: STOP-DATA. T19 lo comprueba.
- **Export lógico** (codec T04): solo para portabilidad e inspección. **No es vía de recuperación**: no hay importador nativo y crear uno es una decisión futura (D-N5), no parte de T05–T25.
- **Software:** el runner aplica solo sus migraciones conocidas y no rechaza una DB con versiones posteriores (`postgres-migrations.js:153-166`). Por eso:
  1. la protección efectiva ante binarios antiguos es el cerco de credenciales (§5.0); la capa 0 solo protege el ledger;
  2. T16 añade al código nuevo una guarda de compatibilidad hacia delante: no arranca si `schema_migrations` tiene versiones que no conoce;
  3. regla operativa: no desplegar binarios anteriores a T05 en un entorno activado, declarado en `activate` (§3.1).
- **Control-plane:** el rollback a JSON queda prohibido con activación (§12). No existe ninguna transición POSTGRES→LEGACY (§6).

## 12. Modo JSON del control-plane

**Hechos:**

- `BEATGALER_CONTROL_PLANE_AUTHORITY` vale `json` por defecto (`control-plane-authority.js:8`).
- En `json`, Cloud configura publicación, Access, billing, sesiones y pin authority con `pool=null` (`server.js:80-88`, `:161-218`).
- En `postgres`, los JSON son virtuales y se vuelcan con upsert de `vaults` por `user_id`, en una sola transacción.
- El rollback a JSON exige `BEATGALER_POSTGRES_ENABLED=true` (`control-plane-authority.js:32-34`).

**Guardas (T05-N):**

1. El catálogo exige control-plane `postgres`. En `json` no se monta.
2. `json` + pool con fila de activación o en `catalog_libraries` → el arranque se niega (STOP-ENV).
3. `prepareControlPlaneCutover` (re-cutover JSON→PG) se niega con activación, para que un snapshot viejo no reinserte vaults como elegibles.
4. Un entorno JSON puro no puede usar los bots ni los chats de un entorno activado (§8.4).

## 13. Riesgos y decisiones pendientes

| # | Riesgo / decisión | Mitigación o dueño |
| --- | --- | --- |
| R1 | Entorno de los datos existentes sin identificar: hay scripts de cutover y borrado contra AWS con vaults reales, además de `tmp/gallery-test`. | `inspect` autorizado por entorno; nada es descartable sin la lista marcada. |
| R2 | Base Git (§14). | Reconciliar con permiso antes de T05; si difiere: STOP-BASE. |
| R3 | El token viejo da acceso directo a Telegram. | Cerrado en diseño: rotación o bots nuevos obligatorios (§5.0) y gateway sin tokens en el cliente (§8.6). Queda pendiente que T11 verifique que la revocación corta las sesiones abiertas. |
| R4 | Flush todo o nada. | Rechazo en origen, cuarentena por usuario y un reintento (§6.2). Riesgo restante: un fallo sistémico detiene el flush global (fail-closed, con alerta). |
| R5 | Sin rollback a INDEX. | Solo T19; sin G4-N no se abre a usuarios reales. |
| R6 | Borrado de cuenta. | Procedimiento §6.1, deshabilitado. Restante: los backups conservan la cuenta durante su ventana; los plazos legales los fija Purp. |
| R13 | Coste y latencia del gateway (§8.6). | T20 mide. **D-N6:** presupuesto de egress y objetivo de latencia, antes de T21. |
| R14 | Drenaje de instancias antiguas sin inventario completo. | `activate` exige el inventario de instancias, el rol antiguo en `NOLOGIN` con 0 backends y la rotación verificada. |
| R7 | Pérdida de un chat `RETIRED` o del `CURRENT` en Telegram. | Se pierde el acceso a esos bytes, no la metadata. Mitigación: C12 backup de medios (R8). |
| R8 | Pérdida permanente en Telegram. | C12, copia de bytes. |
| R9 | `bgPage` legacy (r4) pierde utilidad. | Se conserva; retirarlo es decisión del propietario. |
| R10 | Fixtures y contract-map T01 orientados a INDEX. | Se mantienen como regresión del codec. |
| R11 | El exportador T04 puede no admitir tombstones `CATALOG`. | T19 lo prueba; si falla, gap de T19, no de T05. |
| R12 | Divergencia `vaults.id` JSON↔SQL, porque el upsert por `user_id` no actualiza `id`. | `inspect` la reporta; activar con divergencias: STOP-DATA. |
| D-N1 | Provision explícito (POST) frente a init en GET. | r2 propone POST. Aprobación de Sol (contrato C5). |
| D-N5 | Importador nativo desde export lógico. | Fuera de alcance; decisión futura. |

## 14. Reconciliación Git necesaria (documentada, no ejecutada)

Inspección de solo lectura (2026-11-08):

- HEAD = `a446219` en `local/landing-gallery-unificada`. `origin/local/landing-gallery-unificada` = `c6d7b7c`.
- `3d291d5` (T04) desciende **linealmente** de HEAD: HEAD → … → `c6d7b7c` → `eebb7ea` (T01/T02) → … → `fb7ff97`/`8a192e6`/`b6df121` (T03) → `3d291d5`. Sería fast-forward. Ninguna rama ni remoto local lo contiene: hoy solo lo protege el reflog de objetos.
- De los 101 paths que cambian entre HEAD y `3d291d5`:
  - **95** coinciden byte a byte con el árbol de trabajo (sin seguir o modificados), entre ellos `postgres-migrations.js`, `postgres-schema.test.cjs`, `EVIDENCIA.md` y todo el código y los tests T01–T04;
  - **1** falta en el árbol: `.github/workflows/catalog-g0-postgres-probe.yml`;
  - **5** difieren:
    - `ESTADO.md`, `TAREAS.md` y `T00-REVISION-20261107.md` son locales con solo adiciones posteriores, salvo ESTADO (+24/−1);
    - `C12-DECISION-RECORD.md` (+291/−42): la versión local es **C12-r4**, que incluye "Vigencia C12-r4" y A1/A2/B-legacy e I1/I2/I3 aprobados. La de `3d291d5` es el acta remota abreviada, sin marcadores r4, que r3 ya decidió no adoptar. **Prevalece la local; no hay elección pendiente;**
    - `T00-BASELINE-READONLY.ps1`: `3d291d5` añade la excepción del workflow G0. Viene de commits ya en origin; se marca para Sol porque es el runner protegido.
- `CONTRATO.md`, `MIGRACION.md` y `README.md` son iguales en HEAD y `3d291d5`. Sus cambios locales son posteriores (rediseño).
- `stash@{0}` (autostash del 2026-10-28, `663292b`) ya está protegido por la rama `backup/autostash-20261028-011451`. No tocar.

**Procedimiento propuesto (cada paso con permiso explícito de Purp):**

1. Respaldo con nombre único de todos los `M` y `??` en `E:\777\app\BeatGaler-plan-backups\`, con manifiesto SHA-256 verificado.
2. `git branch backup/t04-3d291d5 3d291d5`: crea una referencia y no toca archivos.
3. Mover la rama sin tocar el árbol: `git reset --mixed 3d291d5`. Solo cambia la referencia y el índice; HEAD es ancestro, así que no se pierde ningún commit. `merge --ff-only` no sirve, porque se niega a sobrescribir los no seguidos que ya existen en `3d291d5`.
4. `git restore --source=3d291d5 -- .github/workflows/catalog-g0-postgres-probe.yml`: solo añade el archivo que falta.
5. Verificar que `git status` muestre como modificados solo los 5 que difieren más los docs del rediseño, y que los hashes del paso 1 sigan iguales.
6. **C12-r4 vigente durante y después de la reconciliación.** Nunca se ejecuta `git restore`, `checkout` ni `merge` sobre los archivos C12 desde `3d291d5`. El conjunto r4 se verifica por SHA-256 antes y después del paso 3: `C12-DECISION-RECORD.md`, `C12-V00-CIERRE-20261107.md`, `C12-V00-INTERACCIONES-APROBADAS-20261107.md`, `C12-B-*`, `C12-CARACTERIZACION-20261107.md`, `EJECUCION-POR-NIVELES-20261107.md` y las dos MATRIZ. Si algún hash cambia: STOP-BASE, y se restaura desde el respaldo del paso 1. Tras el paso 3, `C12-DECISION-RECORD.md` aparecerá como "modificado" frente a `3d291d5`: es esperado, porque es r4 pendiente de commit autorizado.
7. Sol revisa el diff del runner T00 (excepción del workflow G0, ya en origin).

## 15. Criterios para autorizar T05-N

**Para autorizar el encargo (todos):**

1. Purp aprueba r2.1 y Sol dictamina, incluidas D-N1, el cerco §5.0 y las guardas de §6.
2. Reconciliación Git de §14 ejecutada con permiso y verificada: HEAD = `3d291d5`, hashes del respaldo iguales y conjunto C12-r4 intacto.
3. Suites T03 y T04 en verde en CI sobre el HEAD reconciliado, antes de escribir 0027.
4. Encargo explícito de T05, solo LOCAL y CI efímero (`catalog-checks`). Sin activar ningún entorno real.

**Archivos de T05-N:**

- `cloud-server/catalog/authority.js`;
- `cloud-server/migrations/0027_catalog_native.sql`, reconocida en el guard de `postgres-migrations.js` y en `postgres-schema.test.cjs` sin relajar nada;
- capa 1 en `library-index-publication.js`, `direct-transport-control.js` y las entradas C10;
- guardas JSON en `control-plane-authority.js` y `prepareControlPlaneCutover`, más la pre-comprobación del flush;
- `cloud-server/tests/catalog/catalog-authority*.cjs` y la suite T05 en `scripts/catalog-suites.json`.

**Paquetes:**

- **A (MEDIA):** contexto, provision y 0027.
- **B (BAJA):** matriz de rechazos parametrizada, capas 0 y 1.
- **C (MEDIA):** orden de middleware y helpers.

**PASS (CI con PG efímero, sin skips):**

1. Vault elegible + 20 provisiones concurrentes → 1 biblioteca, 1 generación ACTIVE `origin=NATIVE`, chat `CURRENT`, capacidades revocadas, `index_bootstrap_pending=false`; las 19 restantes devuelven `created:false`.
2. `GET /context` nunca escribe: 0 filas nuevas en todos los casos.
3. No elegible (sin marca; vault existente re-upsertado tras la activación; chat ya registrado; cada tabla legacy del predicado) → RESET_REQUIRED y 0 escrituras.
4. Fila LEGACY → RESET_REQUIRED. INSERT LEGACY y POSTGRES→LEGACY con activación → rechazados en DB.
5. Falta flag, activación, PG o authority `postgres` → 503 sin efectos.
6. Capa 0 (defensa del ledger): cada tabla legacy rechaza escrituras para un usuario POSTGRES. **No** se usa como prueba de cerco externo.
7. Capa 1: cada entrada C10, por ruta y por helper, se rechaza con 0 llamadas a los spies de Telegram, MASTER, temporales y SQL legacy. En `publish()` se cubren los tres puntos de §5.1: la entrada (incluidos `pinned`, `bootstrap` y el camino `same`), bajo el lock antes de `deleteAndVerifyMessages` y `publishIndexBuffer`, y la provisión concurrente entre la entrada y el lock.
7b. La respuesta `session/start catalog-v1` no contiene `bot_token`, `api_id` ni `api_hash` (sobre el JSON serializado).
7c. Cuarentena del flush (§6.2): dos usuarios, uno en conflicto. El otro hace COMMIT, el conflictivo queda en cuarentena con `409 VAULT_QUARANTINED`, la base del delta no avanza para él y el respaldo del trigger reintenta una sola vez.
7d. §6.1 deshabilitado: sin fila `MEDIA_DELETED` y la GUC correspondiente, `DELETE users` se rechaza; con el flag apagado, ningún endpoint ni CLI crea filas en `catalog_account_deletions`.
8. Carrera provision contra publicación legacy: gana exactamente una y la otra falla cerrada.
9. Cascadas: `DELETE users`, `DELETE vaults`, `TRUNCATE`, DELETE de la generación ACTIVE y de un media object no DELETED → rechazados; catálogo intacto.
10. Rebind: un cambio de chat en origen → `CATALOG_VAULT_REBIND_FORBIDDEN`; en el flush, cuarentena (7c) y trigger como respaldo. Con `catalog_chat_rebinds` abierto → permitido, el chat anterior pasa a RETIRED y las ubicaciones quedan intactas.
11. Reglas **DB** de §7: cada violación se rechaza en una generación NATIVE.
12. Era o época ausente o vieja, tenant ajeno, cambio de estado entre check y commit.
13. `json` + pool con activación → no arranca; re-cutover con activación → se niega.
14. Regresión sin skips: unit, faults, integration, T03 14/14 y T04 con 0027 aplicada. Si T03 o T04 cambian de resultado: STOP-CONTRACT (una guarda no quedó condicionada).

**STOP:**

- INTEGRITY si una ruta toca Telegram de forma destructiva antes del cerco.
- CONTRACT si 0027 no cabe como migración aditiva condicionada.
- BASE si §14 no está resuelto.
- APPROVAL si se necesita activar, rotar tokens o tocar Telegram real.

Al terminar, entregar evidencias y detenerse.
