# Evidencia y límites

## E1. Base reproducible

Inspección local realizada el 7 de noviembre de 2026:

| Dato | Resultado |
| --- | --- |
| Carpeta | `E:\777\app\BeatGaler` |
| Rama activa | `local/landing-gallery-unificada` |
| HEAD | `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b` |
| Referencia `main` local | `10ae1908d947cc4f6981469f9a722936ec3ee57e` |
| Base citada en la idea | `7f2dc5823a4d2cd87333ee3b6833ae46e9029b3b`, presente en Git local |
| Cambios preexistentes sin seguimiento | `Claude outputs/`, `beatgaler-console.jpg`; no modificados |
| AGENTS.md | No encontrados en la ruta de ancestros comprobada ni en el inventario visible del repositorio. Repetir en el checkout de implementación. |
| Node / npm ejecutados | `22.23.2` / `10.9.8`, coinciden con `package.json` |

No se hizo fetch. No se inspeccionaron servicios productivos. `BLUEPRINT/CURRENT-STATE.md` documenta producción en `a8418223527f88e9d34db8e05abb10216942013c`; es una referencia documental, no una comprobación actual del despliegue.

Comparé `7f2dc582..HEAD` y `main..HEAD` en `cloud-server`, `src/features/{cloud,library,edit,import,trash}`, `src/platform`, `src/domain` (y Tauri en la primera comparación): solo aparecieron tres archivos de biblioteca, `LibraryUxBridge.tsx`, `WebLibraryPagination.tsx`, `librarySelectors.ts`, 8 inserciones y 4 eliminaciones. Esto respalda la continuidad de los flujos inspeccionados, no la equivalencia de todo el producto ni de producción.

## E2. Hechos observados en código

Las rutas son relativas a la raíz. Los números de línea corresponden al HEAD anterior; para implementar usar además los símbolos indicados.

| Hecho | Fuente y ubicación |
| --- | --- |
| PostgreSQL ya tiene identidad/estado/reservas, no el catálogo completo. | `cloud-server/migrations/0015_library_beat_quota.sql:3`, tablas `library_quota_state`, `library_beat_reservations`, `library_beats`. Estados del ledger: ACTIVE/TRASH. |
| Hay tombstones SQL permanentes y purges pendientes. | `cloud-server/migrations/0018_library_trash_purge.sql:5`, estados PENDING/CONFIRMED/LEGACY_TOMBSTONE. No perderlos aunque no aparezcan en INDEX. |
| Papelera ocupa cuota; reservas pendientes también. | `cloud-server/library-beat-quota.js`, `snapshot`, `reserve`, `expire`. TTL actual de reserva: 15 minutos. |
| Publicación Web normal usa Cloud y MASTER. | `src/features/cloud/webGalerCloudTransport.ts:250`, `publishLibraryIndex`; `cloud-server/server-core.js:2293`, `/transport/index/publish`. |
| La publicación serializa el manifest completo y limita su tamaño a 16 MiB. | `cloud-server/library-index-publication.js:196`, `publish`. El parser HTTP de esa ruta admite 24 MB: no confundir ambos límites. |
| Edición de metadatos lee INDEX y publica un reemplazo. | `src/features/edit/webBeatEdit.ts`, `commitWebBeatEdit`, lectura al inicio y `runtime.replaceLibraryIndex` al final. |
| Importar también recalcula `sort_order` para todos los beats. | `src/features/import/webImportCommit.ts`, construcción de `candidate.beats`. Una API por beat que conserve ese recálculo no resuelve todo el coste global. |
| La página materializa hasta 240 beats, pero antes descarga y normaliza INDEX completo. | `src/features/library/webLibrary.ts:263`, `loadWebLibraryPage`, `updatePlaybackRoutingCacheFromManifest`, `boundedPageFromNormalizedManifest`. |
| Búsqueda, tags y orden usan el array recibido por UI. | `src/features/library/librarySelectors.ts`, `selectFilteredAndSortedBeats`; `webLibraryWindow.ts` pagina primero. El nuevo filtrado global debe definirse y probarse. |
| Existen validadores de metadata y un rango amplio de rating en lectura. | `src/lib/metadataValidation.ts`: BPM 60–300 o vacío, tags hasta 40 caracteres/30 entradas; `webLibrary.ts`, `beatFromWebLibraryEntry`, limita rating a entero 0–255. `cleanTags` puede descartar/normalizar entradas y no sirve como importador sin pérdida. |
| Papelera/restauración reconstruyen arrays de INDEX. | `src/features/trash/webTrash.ts`, `moveWebBeatsToTrash`, `restoreWebBeatFromTrash`. Papelera registra `trash_id`, `trashed_at`, `purge_after` a 14 días. |
| SQL permanece abierto durante red externa. | `library-index-publication.js`, `recover`, `publish`, `purgeTrash`; `project-upload-authority.js`, `upload`; `direct-index-pin-authority.js`, `ensure`; `library-beat-quota.js`, `bootstrap`. |
| Bootstrap atómico puede retener conexión/lock aunque no use BEGIN. | `cloud-server/atomic-library-index.js`, `ensure`: `pg_advisory_lock` hasta terminar creación externa. Debe evitarse también este patrón en la ruta nueva. |
| El arranque espera recuperación de bibliotecas. | `cloud-server/server.js:80`: `ensureAll` y `recoverAll`; esta última recorre secuencialmente, puede repinear, purgar y migrar PROJECT legacy. No es una lectura inocua. |
| Hay ruta antigua de reemplazo dentro del Worker. | `src/features/cloud/webTransport.worker.ts:2529`, `replaceLibraryIndex`: sendMedia, pin, delete antiguo. Su existencia no prueba que el flujo Web principal actual la use. |
| Los bots se promueven sin pin/edit/delete administrativos. | `cloud-server/direct-transport-control.js:710`, `directBotAdminRights`; `direct-index-pin-authority.js`, marcadores de restricción. No demuestra revocación de sesiones previas ni imposibilidad de borrar mensajes propios. |
| Autorización Direct tiene su propio alcance, sesión, generación y TTL. | `cloud-server/direct-capability-boundary.js`, `OPERATION_SCOPE_RULES`, `normalizeScope`; IDs hasta 192 caracteres en capability frente a 256 en ledger. No usar truncamiento para conciliarlos. |
| Existe otra escritura global de rutas de playback. | `cloud-server/startup-routing-index.js:277`, `/transport/routing/reconcile` llama `store.replace` con snapshot del cliente. También decora session/start e index/commit. Debe cercarse. |
| PROJECT actual atraviesa un temporal de Cloud. | `cloud-server/project-upload-route.js`, middleware Multer, `uploadProject`, borrado del temporal al finalizar. |
| PROJECT tiene recibos e intento de recuperación por hash. | `cloud-server/project-upload-authority.js`, `upload`; `direct-transport-control.js`, `findProjectFile`, `publishProjectFile`, `verifyProjectMessage`. No es una garantía probada de exactly-once. |
| Cambiar un PROJECT exige un documento; uno histórico sin cambios se preserva. | `cloud-server/project-access.js`, `projectMessageId`, `verifyChanges`. `migrateLegacyProjectsOnce` en `library-index-publication.js` reconoce partes antiguas. |
| No todos los datos persistentes aparecen en el tipo UI Beat. | `src/types/index.ts`, `src/domain/beat.ts`, constructores de import/edit, `library-trash-assets.js` y `src-tauri/src/versioning.rs`. Deben conservarse manifests, extras, orden, topics y metadata_message_id. |
| Hay infraestructura durable previa, con semántica ligada a INDEX. | `migrations/0001_control_plane.sql`: `direct_operations`, `garbage_journal`, `jobs`; `garbage-reconciliation-worker.js` usa INDEX y descubre huérfanos. No reutilizarlo sin adaptar la autoridad. No encontré conexión de este worker a `server.js` que permita declararlo ya operativo en producción. |
| El runner y una prueba prohíben tablas `beats/trash/deleted`. | `cloud-server/postgres-migrations.js:64`, `assertInitialSchemaContract`; `tests/postgres-schema.test.cjs`. Es contrato histórico de control plane, no evidencia de que el catálogo SQL sea imposible. |
| Hay una prueba destructiva que hereda DATABASE_URL. | `cloud-server/tests/postgres-live.integration.cjs:38–50`: fallback local y `DROP SCHEMA public CASCADE`. No ejecutarla con el entorno del desarrollador. |

## E3. Dependencias verificadas

Leídas en ambos `package-lock.json`, no deducidas de rangos semver:

| Componente | Versión bloqueada | Uso |
| --- | --- | --- |
| `pg` (Cloud) | 8.23.0 | Conexiones, transacciones y migraciones. |
| `telegram` (Cloud, GramJS) | 2.26.22 | MASTER. |
| `@mtcute/web` / `@mtcute/core` | 0.31.0 | Direct Web y capacidades Telegram. |
| Express | 5.2.1 | API Cloud. |
| Multer | 1.4.5-lts.2 | Temporal de PROJECT; package.json tiene un rango desde lts.1. |

En el SDK instalado `node_modules/@mtcute/core/highlevel/methods/messages/send-media.d.ts:22` existe `randomId?: Long`; `send-media.js:33` genera uno nuevo si se omite. `webTransport.worker.ts:3272` no lo pasa. Se confirma una herramienta disponible para el diseño; **no** el resultado de reconectar/reintentar tras pérdida de respuesta.

No se propone actualizar dependencias dentro de esta migración. Una actualización necesaria requiere revisar contrato y volver a probar el transporte.

## E4. Comprobaciones ejecutadas

Previamente se leyeron los archivos de estas pruebas: usan dobles o inspección de archivos, no una conexión a servicios.

```powershell
node --version
npm --version
node --test cloud-server/tests/library-beat-quota.test.cjs cloud-server/tests/postgres-schema.test.cjs cloud-server/tests/project-upload-admission.test.cjs
```

Resultado: **6 tests PASS, 0 fallos, 0 skip**. El contrato de esquema encuentra 25 migraciones. Esta ejecución no prueba integridad de datos reales, rendimiento, funcionamiento del SDK contra Telegram, concurrencia SQL ni recuperación productiva.

No se ejecutó `npm test`, suites de integración PostgreSQL, un servidor Cloud, AWS, migraciones, procesos Telegram ni tests E2E con cuentas. No se instalaron dependencias ni se modificó código de aplicación. El producto de esta tarea son los documentos del presente directorio.

## E5. Referencias técnicas externas consultadas

- Transacciones `pg`: todas las sentencias de una transacción deben compartir cliente. El wrapper nuevo además lo libera antes de cualquier red externa, una decisión de este plan. [node-postgres, Transactions](https://node-postgres.com/features/transactions).
- `SKIP LOCKED` sirve para distribuir trabajo de cola; su vista incompleta no sirve para afirmar que una biblioteca está conciliada. Se usa para reclamar jobs, nunca para comparar snapshots. [PostgreSQL, SELECT](https://www.postgresql.org/docs/18/sql-select.html).
- PITR combina backup base y WAL. Una exportación JSON del catálogo no sustituye ese mecanismo. [PostgreSQL, Continuous Archiving and PITR](https://www.postgresql.org/docs/18/continuous-archiving.html).
- `messages.sendMedia` incluye `random_id` para evitar reenvíos. El contrato de protocolo no acredita el comportamiento de la versión concreta del SDK tras reconexiones, ni garantiza recuperar el message ID. [Telegram, messages.sendMedia](https://core.telegram.org/method/messages.sendMedia).

Las páginas PostgreSQL consultadas resolvieron a versión 18; **no se verificó la versión desplegada de BeatGaler**. T00 debe fijarla y usar su documentación antes de crear SQL dependiente de versión.

## E6. Lo que sigue sin estar demostrado

SHA y configuración realmente desplegados; versión/extensiones PostgreSQL; tamaño/distribución y campos de bibliotecas reales; clientes y procesos antiguos activos; permisos efectivos Telegram; capacidad del SDK para reconciliar cada resultado incierto; retención y cobertura de backups; objetivos empresariales de RPO/RTO; latencia y capacidad actuales.

Estas incógnitas son entradas de puertas concretas en TAREAS/MIGRACION. No invalidan construir el esquema y pruebas aisladas; impiden certificar o ejecutar el corte real.


## ActualizaciÃ³n de evidencia LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
- `HEAD` LOCAL comprobado durante esta actualizaciÃ³n: `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`; rama: `local/landing-gallery-unificada`.
- La base del anÃ¡lisis original era `7f2dc5823a4d2cd87333ee3b6833ae46e9029b3b`. La integraciÃ³n `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b` agrega 7 commits/59 archivos. `cloud-server/` conserva el Ã¡rbol `bcb488ae3802dfd2bbe8f3fe6245b314a152c189`, al igual que `src-tauri/` y `package*.json` frente a esa base.
- Nuevo frontend a inventariar: `src/app/WebExperience.tsx`, `WebGalleryEntry.tsx`, `WebGalleryWorkspace.tsx`, `AppShell.tsx`, `src/features/design/GALLERY/GalleryChrome.tsx`, `src/features/library/librarySelectors.ts`, `WebLibraryPagination.tsx`, `src/components/BeatCard.tsx` y `Player.tsx`.
- Evidencia de GitHub no equivale a inspecciÃ³n de archivos modificados sin commit. Revisar `git status` y `git diff 31861e6..HEAD` antes de revalidar. CI histÃ³rico #151: Web build PASS; Direct persistent gate FAIL (causa pendiente de clasificaciÃ³n). No afirmar que G0 pasa.
- VÃ©ase [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md).
