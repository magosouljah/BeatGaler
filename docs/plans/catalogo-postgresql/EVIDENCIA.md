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


## Actualización de evidencia LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
- `HEAD` LOCAL comprobado durante esta actualización: `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`; rama: `local/landing-gallery-unificada`.
- La base del análisis original era `7f2dc5823a4d2cd87333ee3b6833ae46e9029b3b`. La integración `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b` agrega 7 commits/59 archivos. `cloud-server/` conserva el árbol `bcb488ae3802dfd2bbe8f3fe6245b314a152c189`, al igual que `src-tauri/` y `package*.json` frente a esa base.
- Nuevo frontend a inventariar: `src/app/WebExperience.tsx`, `WebGalleryEntry.tsx`, `WebGalleryWorkspace.tsx`, `AppShell.tsx`, `src/features/design/GALLERY/GalleryChrome.tsx`, `src/features/library/librarySelectors.ts`, `WebLibraryPagination.tsx`, `src/components/BeatCard.tsx` y `Player.tsx`.
- Evidencia de GitHub no equivale a inspección de archivos modificados sin commit. Revisar `git status` y `git diff 31861e6..HEAD` antes de revalidar. CI histórico #151: Web build PASS; Direct persistent gate FAIL (causa pendiente de clasificación). No afirmar que G0 pasa.
- Véase [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md).

## E7. Evidencia de auditoría G0 remota (2026-11-07)

HEAD remoto inicial `edabd715664f9564346e95b8553b68b4ac411da9` de `local/landing-gallery-unificada`: un commit y siete archivos exclusivamente documentales sobre `31861e6`. Se verificaron los siete documentos, T00–T25, G0–G4 y contratos C1–C12. El usuario aportó estado limpio salvo dos archivos/carpetas sin seguimiento ajenos al commit. Los seis PASS de E4 son históricos: esta auditoría no ha ejecutado nuevos tests, CI, DB ni Telegram. El FAIL histórico de Direct en PR #151 sigue por clasificar. Véase [G0-AUDITORIA-20261107.md](G0-AUDITORIA-20261107.md).

## E8. T00 iniciado — verificación estática adicional

El usuario confirmó fast-forward a `f90b488` y `git status --short` con solo `Claude outputs/` y `beatgaler-console.jpg` sin seguimiento. La ejecución remota de T00 revisó el árbol de GitHub completo (1211 entradas, sin truncamiento), que contiene **25 migraciones numeradas 0001–0025** y **ningún AGENTS.md versionado**. Se verificaron `docs/ENVIRONMENTS.md`, `BLUEPRINT/CURRENT-STATE.md`, ambos `package.json`, encabezados de ambos `package-lock.json`, código de configuración y tests descritos en [T00-REVISION-20261107.md](T00-REVISION-20261107.md). No se ha revisado la presencia de AGENTS locales fuera de Git ni se ha observado la versión del servidor PostgreSQL.

No se ejecutaron tests en el checkout Windows desde GitHub; tampoco se invocaron workflows ni scripts con escritura. El runner de solo pruebas inspeccionadas se entrega sin resultados fabricados. [T00-BASELINE-READONLY.ps1](T00-BASELINE-READONLY.ps1) deja fuera `postgres-live.integration.cjs` porque contiene `DROP SCHEMA public CASCADE` y puede heredar `DATABASE_URL`. `tests/integration/issue97RuntimeWebFollowup.test.ts` exige `preconnectRememberedWebDirect()` en `src/main.tsx` aunque LOCAL lo desplaza a Gallery autenticada: se espera discrepancia y se debe clasificar con salida real, sin cambiar runtime para hacer pasar la prueba.

## E9. Logs de CI histórico revisados en T00

Se consultó el run de GitHub Actions [42353075806](https://github.com/magosouljah/BeatGaler/actions/runs/42353075806) en su commit fuente `31861e6`. El gate PostgreSQL persistent assignment **PASS histórico**. Direct TypeScript: **188 PASS y 3 FAIL**; los tres archivos de test buscan inicialización Direct en `src/main.tsx` cuando la nueva Gallery la monta tras Auth. Cloud guard: **FAIL** por ancla literal de mutación en memoria en `regression-direct-manager-only.test.mjs:76`. Se amplió el runner seguro para reproducir esos cuatro casos; aún **no hay ejecución nueva** ni diagnóstico funcional definitivo. Ver [T00-REVISION-20261107.md](T00-REVISION-20261107.md), sección 6.

## E10. Resultados reales del runner T00 en LOCAL

El usuario entregó salida del ejecutor `T00-BASELINE-READONLY.ps1` desde `E:\777\app\BeatGaler`, HEAD `da735bed34733b5ed1e5e22a9d2e389d78bbad43`. SHA-256 del archivo de salida original recibido: `4d3d3f1962efe5e1c99cafeb6b8d5a49bb1015d93d143835dd88958bb6a4864e`. **Pruebas contadas:** E4 6/6 PASS, config 3/3 PASS, seis suites DOM 23/23 PASS y tres suites de arranque 24/27 PASS, 3 FAIL (56 PASS, 3 FAIL). Además, guard AST exit 0, guard de mutación exit 1, TypeScript `--noEmit` exit 0.

Los tres fallos del arranque son los esperados por asserts de import/call en `src/main.tsx` (ubicación antigua); el guard mutante usa un literal viejo de `installPersistentDirectSessionStart` que omite `indexPinAuthority`, aunque el guard principal reconoce la instalación con ese argumento. No se alteraron tests ni código; el reporte se limita a diagnóstico reproducible. Ver [T00-LOCAL-RESULTADOS-20261107.md](T00-LOCAL-RESULTADOS-20261107.md).

## E11. T00 — correcciones de tests (pendientes de ejecución)

La revisión del código confirmó `AuthExperienceGate` y `WebGalleryWorkspace` como frontera actual. Se reescribieron tres asserts heredados de ubicación en `main.tsx`, se añadió suite de comportamiento real de mount con fakes, y se repararon 4 anclas del mutation guard Cloud que aún defiende 25 escenarios. Ver [T00-TEST-CORRECTIONS-20261107.md](T00-TEST-CORRECTIONS-20261107.md). Las 25 anclas ya coinciden estáticamente con la fuente; **no hay nuevo PASS de ejecución**. Referencia de imagen de PG16 obtenida del workflow versionado, no de un servidor local.

## E12. T00 Windows tras correcciones (HEAD 259b077)

El usuario ejecutó el runner: 6/6 E4, 3/3 PostgreSQL simulado, 31/32 DOM, 27/27 legacy bootstrap; guard AST PASS, 25/25 mutaciones PASS, TypeScript PASS. El único FAIL fue `webGalleryDirectAuthBoundary.test.tsx:134`: `data-test-gallery-app` todavía nulo inmediatamente tras resolver `restoreBeatGalerSession` y un turno `setTimeout(0)`. El log no muestra error de red, pero tampoco permite concluir que el módulo dinámico de Gallery haya terminado de cargar. El test ahora espera la renderización asíncrona con timeout y comprueba que `restore` se invoque antes de resolver. Se requiere nueva ejecución para confirmar. El equipo reportó Docker, Podman y psql NO DISPONIBLES en PATH; no es prueba de inexistencia de un servidor real fuera de PATH. Estado T00 NO PASS.

## E13. T00 baseline Windows completo — 68 PASS / 0 FAIL

Salida aportada por el usuario con HEAD `5b199161351a05c62df79870d563cd7aceb5572f`. E4 6/6, fake Postgres/Direct 3/3, DOM 32/32, integración Direct 27/27; 7/7 fases del runner exit 0. Además guard Cloud AST PASS, **25/25 mutaciones rechazadas**, TypeScript `--noEmit` PASS. La suite DOM imprime warning React de Suspense fuera de `act` para un caso signed-out; prueba PASS y warning registrado. Ningún servicio o DB real fue accedido. Docker/Podman/psql no encontrados en PATH Windows. EVIDENCIA E12 permanece como antecedente de fallo ya corregido. Ver [T00-BASELINE-PASS-20261107.md](T00-BASELINE-PASS-20261107.md).

## E14. Preparación de probe G0 PostgreSQL y entrega C12 a IDE

Se creó el workflow de `push` sobre LOCAL, archivo `.github/workflows/catalog-g0-postgres-probe.yml`: PostgreSQL 16 digest fijado en job y service aislados, DB de prueba/rol explícitos, protección de identidad y consulta de colación, UTF8, `pg_trgm`; agrega descriptor en run summary. **No se declara que haya ejecutado ni que sea PASS sin leer resultados del run**. Sin `checkout`, AWS, Telegram, migraciones ni base real. Se agregó `G0-C12-IDE-MASTER-PROMPT-20261107.md` para el diseño C12. Ver [G0-LAB-POSTGRES-ACTIONS.md](G0-LAB-POSTGRES-ACTIONS.md).

## E15. Primer run de PostgreSQL G0 — fallo de consulta de locale

<https://github.com/magosouljah/BeatGaler/actions/runs/42416620409>. Job `postgres-g0-probe`: inicialización de contenedores PASS, guard de target PASS, `CREATE SCHEMA/TABLE/EXTENSION pg_trgm` PASS; servidor PostgreSQL 16.15 reportado. Falla en `current_setting('lc_collate')` porque no existe el parámetro; sustituido por `pg_database.datcollate/datctype` para siguiente run. No confundir con fallo de `pg_trgm` ni con descriptor completo validado. **Run FAIL; STOP-ENV abierto.**

## E16. Entorno G0 PostgreSQL 16 efímero — PASS verificado

[GitHub Actions 42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955), `completed/success`, job `postgres-g0-probe` PASS en todos los pasos. SQL: `G0_PROBE_PASS`, PG 16.15 Debian, `UTF8`, `en_US.utf8` collation y ctype por catálogo, `pg_trgm` 1.6 instalado, DB/rol exclusivos y `G0_RUN_MARKER_VERIFIED` para run ID/commit. Contenedores y network eliminados por Actions. El fallo del run previo (E15) quedó resuelto. **Descriptor de laboratorio G0 PASS; aún no hay esquema de catálogo, pruebas funcionales PostgreSQL ni T02.** Ver [G0-POSTGRES-VERIFIED-20261107.md](G0-POSTGRES-VERIFIED-20261107.md).

## E17. C12 — lectura de implementación LOCAL

Ver [C12-DECISION-RECORD.md](C12-DECISION-RECORD.md). Fuentes del commit `894f486`: `useBeatGalerComposition.ts:103–118` ANY Web/ALL Desktop; `librarySelectors.ts:15–33` filtros/sort; `webLibrary.ts:13,238–316` página 240 y slice INDEX; `webLibraryNavigation.ts:1–26` bgPage offset; `WebLibraryPagination.tsx:24–32` navegación. Faltan paridad Unicode/SQL y resolución de bookmarks profundos; no se corrieron esas pruebas ni se cambió el producto.
