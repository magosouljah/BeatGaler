# Evidencia y límites

**Cierre T00/G0 LOCAL (2026-11-08):** registrado por dictamen GPT-6 sobre `G0-REVISION-FINAL-v2.zip` (48/48 hashes, baseline 68/68, smoke rutas 6/6, smoke autenticado simulado 5/5, PostgreSQL G0 verificado, C12-r4 cerrado). No se repitieron pruebas ni se generó nuevo ZIP/informe. El smoke simulado no prueba transporte real, Telegram ni producción. Evidencia T01 en `consumer-map.md` / `contract-map.json`.


**Vigencia C12-r4 (2026-11-07):** [cierre C12-r4](C12-V00-CIERRE-20261107.md) integra el [acta I1/I2/I3 aprobada](C12-V00-INTERACCIONES-APROBADAS-20261107.md) de `c6d7b7cf4455623ab2da7bfbdadabb0b4b3e3b81` y las respuestas explícitas del usuario de este encargo. **A1/A2/B-legacy e I1/I2/I3 aprobados; decisiones C12/V00 cerradas para diseño.** Shuffle sin repetición por ronda, aviso de selección solo si existía y rename también en papelera sin alterar su estado. Las menciones pendientes r2/r3 quedan como antecedentes, sustituidas por r4. **T00/G0 no PASS; T01 bloqueada; T02 no iniciada.** No hay autorización de implementar.


**Cierre de integración documental r3:** diff whitespace/enlaces/fences PASS; caracterización r2 intacta byte a byte,5/5 MD remotos exactos. Inventario de7 MD modificados y6 incorporados en [plan B sección11](C12-B-INTEGRACION-Y-PLAN-20261107.md). Sin nuevas pruebas de producto/SQL/performance, sin runtime ni servicios reales. B-experiencia aprobada; C12/T00/G0 continúan NO PASS y T01 bloqueada por decisiones pendientes, no por falta de aprobación del scroll infinito.


## Evidencia vigente C12-r3 — reconciliación e infinite scroll

Local HEAD `a4462191aea29ffdae136f04e1fdc2e4024291d1`; remoto obtenido `b585540a3a82bc8604d8d6de603514af48b5feb4`. Sin diferencias runtime src/cloud-server entre ambos. Fetch genérico falló por rama release del refspec inexistente; fetch explícito de LOCAL pasó sin cambiar configuración ni HEAD. Copia local15/15 archivos verificada con SHA256 antes de editar, snapshot remoto19 archivos y reconciliación append-only descritos en [plan B sección1](C12-B-INTEGRACION-Y-PLAN-20261107.md). Caracterización r2 conservada sin cambios, con su SHA y resultados históricos.

Se incorporó exactamente el [anexo oficial B](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md): experiencia continua aprobada, detalles legacy no. V01–V14 del plan B citan fuentes reales: grid monta todo filteredBeats, currentBeat depende del array, queue releaseFile y selección podan ausentes, estilos declaran239px/columnas responsive, Web manualLibraryReorder=false. Es lectura estática, no medición visual ni prueba de virtualización.

No se ejecutaron nuevas suites de producto/SQL, browser fixtures, performance, producción, AWS o Telegram. No se instaló virtualizador ni se modificaron runtime/CSS/DESIGN/tests/lockfiles. Las fuentes técnicas React/ResizeObserver/WAI/CSS se enlazan donde fundamentan el diseño; no certifican compatibilidad ejecutada. Baseline y probe previos siguen históricos; no se relanzaron workflows. Resultado de checks documentales al cierre más abajo.

## Antecedente C12-r2 — evidencia histórica conservada

El análisis C12 se hizo sobre `a4462191aea29ffdae136f04e1fdc2e4024291d1` en LOCAL. Ver [C12-CARACTERIZACION-20261107.md](C12-CARACTERIZACION-20261107.md): índice E01–E14 con rutas/líneas y callers, comparación con remoto sin mover HEAD, baseline histórico, verificación independiente del run PostgreSQL G0 y resultados sintéticos Node/Chrome. Los registros siguientes conservan su SHA/fecha originales; no son una certificación nueva del catálogo.

Hechos que corrigen la simplificación inicial: Gallery filtra/ordena después de recortar240; BPM se busca como texto sin lowercase; normalizador de DTO descarta tipos no string de BPM/key, que el importador debe conservar raw; localeCompare depende del entorno; NaN en sort BPM no implica inválidos al final; bgPage no tiene límite seguro y el window reubica offsets fuera de rango en última página. Una firma no hace equivalente una ventana legacy y un resultado ordenado globalmente.

El [acta C12-r2](C12-DECISION-RECORD.md) fija decisiones técnicas y deja A1/A2/B **STOP-DESIGN**. Probe PG16.15/UTF8/en_US.utf8/pg_trgm1.6 verificado resuelve descriptor G0, no ICU SQL, Edge, T02, performance ni G0 global. No se ejecutaron consultas DB ni pruebas de servicios; el experimento inicial de tags con target incorrecto se descartó y se repitió con ES2022, como registra el anexo.

Verificación de esta entrega: `git diff --check` PASS; revisión de enlaces locales y fences Markdown de los siete documentos PASS; `git status --short` contiene únicamente cinco documentos rastreados modificados, dos documentos C12 nuevos y los dos no rastreados preexistentes. Comparación `git diff 31861e6406ac10073d368aa5d8a4edcb5dfd2d2b HEAD --stat -- src cloud-server` sin diferencias. Estos checks documentales no equivalen a ejecutar las pruebas del producto ni a aceptar G0.

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


## Antecedentes remotos reconciliados (históricos)

Importados de `b585540a3a82bc8604d8d6de603514af48b5feb4`; no reemplazan C12-r2/r3 ni el estado vigente.

## E14. Preparación de probe G0 PostgreSQL y entrega C12 a IDE

Se creó el workflow de `push` sobre LOCAL, archivo `.github/workflows/catalog-g0-postgres-probe.yml`: PostgreSQL 16 digest fijado en job y service aislados, DB de prueba/rol explícitos, protección de identidad y consulta de colación, UTF8, `pg_trgm`; agrega descriptor en run summary. **No se declara que haya ejecutado ni que sea PASS sin leer resultados del run**. Sin `checkout`, AWS, Telegram, migraciones ni base real. Se agregó `G0-C12-IDE-MASTER-PROMPT-20261107.md` para el diseño C12. Ver [G0-LAB-POSTGRES-ACTIONS.md](G0-LAB-POSTGRES-ACTIONS.md).

## E15. Primer run de PostgreSQL G0 — fallo de consulta de locale

<https://github.com/magosouljah/BeatGaler/actions/runs/42416620409>. Job `postgres-g0-probe`: inicialización de contenedores PASS, guard de target PASS, `CREATE SCHEMA/TABLE/EXTENSION pg_trgm` PASS; servidor PostgreSQL 16.15 reportado. Falla en `current_setting('lc_collate')` porque no existe el parámetro; sustituido por `pg_database.datcollate/datctype` para siguiente run. No confundir con fallo de `pg_trgm` ni con descriptor completo validado. **Run FAIL; STOP-ENV abierto.**

## E16. Entorno G0 PostgreSQL 16 efímero — PASS verificado

[GitHub Actions 42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955), `completed/success`, job `postgres-g0-probe` PASS en todos los pasos. SQL: `G0_PROBE_PASS`, PG 16.15 Debian, `UTF8`, `en_US.utf8` collation y ctype por catálogo, `pg_trgm` 1.6 instalado, DB/rol exclusivos y `G0_RUN_MARKER_VERIFIED` para run ID/commit. Contenedores y network eliminados por Actions. El fallo del run previo (E15) quedó resuelto. **Descriptor de laboratorio G0 PASS; aún no hay esquema de catálogo, pruebas funcionales PostgreSQL ni T02.** Ver [G0-POSTGRES-VERIFIED-20261107.md](G0-POSTGRES-VERIFIED-20261107.md).

## E17. C12 — lectura de implementación LOCAL

Ver [C12-DECISION-RECORD.md](C12-DECISION-RECORD.md). Fuentes del commit `894f486`: `useBeatGalerComposition.ts:103–118` ANY Web/ALL Desktop; `librarySelectors.ts:15–33` filtros/sort; `webLibrary.ts:13,238–316` página 240 y slice INDEX; `webLibraryNavigation.ts:1–26` bgPage offset; `WebLibraryPagination.tsx:24–32` navegación. Faltan paridad Unicode/SQL y resolución de bookmarks profundos; no se corrieron esas pruebas ni se cambió el producto.

## Transferencia normativa vigente C12-r4

[cierre C12-r4](C12-V00-CIERRE-20261107.md) integra las aprobaciones explícitas y sustituye pendientes/recomendaciones incompatibles r2/r3. A1 ICU fijo, A2 binary64/clase y B-legacy <=10.000 quedan aprobados. I1 selección global con aviso solo si había selección; I2 audio continuo, nuevo query y cola prioritaria, Shuffle sin repetición por ronda; I3 rename ACTIVE/TRASH sin modificar estado. Se descarta fijar permanentemente la búsqueda musical al pulsar Play.

Aplicar las dependencias, algoritmos, alternativas y STOP de sección 7 del cierre a T01/T03/T06/T07/T13/T14/T20 y V00–V11. Membresías SQL persistidas, selección CAS, facetas, journal y swaps Shuffle no son memoria global del cliente. T01/T06 deben producir inventario y contratos tipados completos en sus tareas futuras. T00 revisa formalmente base/descriptor/baseline/contrato, sin volver a solicitar las aprobaciones resueltas. T01 permanece bloqueada; ningún paso de implementación iniciado.

## Verificación documental r4 ejecutada

`git diff --check`: PASS. Comprobación local de enlaces, fences y caracteres de sustitución: **22 Markdown, 0 errores**. Caracterización r2 idéntica byte a byte al snapshot previo; nuevo anexo I1/I2/I3 idéntico al blob remoto c6d7b7c. Backup previo verificado: 21 archivos con manifiesto SHA256. HEAD permanece a4462191aea29ffdae136f04e1fdc2e4024291d1. Diff de producto entre HEAD/remoto vacío. No cambios de runtime, tests, workflows ni runner; no commit/push. `Claude outputs/` y `beatgaler-console.jpg` preservados.

Entrega r4: nuevo `C12-V00-CIERRE-20261107.md` y anexo remoto `C12-V00-INTERACCIONES-APROBADAS-20261107.md`; actualizados acta C12, plan B, README, CONTRATO, TAREAS, ESTADO y EVIDENCIA. Los demás cambios Git preceden este encargo. Se corrigió un fallo del script documental por lectura Python cp1252 usando UTF-8 explícito; se validaron después todos los MD. No hubo pérdida/restauración de contenido ni ejecución de producto.

Decisiones C12/V00 cerradas para diseño conforme a respuestas del usuario, incluyendo corrección de Shuffle sin repeticiones. No tests de aplicación, SQL, browser, uniformidad RNG, benchmarks ni despliegues ejecutados. G0/T00 requieren dictamen formal independiente; T01 bloqueada, T02 no iniciada.

## E18. Plan N1 — matriz V y verificación documental (2026-11-07)

Comprobaciones ejecutadas en esta sesión. No se atribuyen aquí pruebas de otras IDE ni del usuario.

| Comprobación | Método exacto | Resultado |
| --- | --- | --- |
| Shell Windows | `device_bash` | No disponible: «Workspace unavailable». No se ejecutó ningún comando `git` |
| Rama y HEAD | lectura de `.git/HEAD` y `.git/refs/heads/local/landing-gallery-unificada` | rama `local/landing-gallery-unificada`, HEAD `a4462191aea29ffdae136f04e1fdc2e4024291d1` |
| Remoto registrado | `.git/refs/remotes/origin/local/landing-gallery-unificada` y `FETCH_HEAD` | `c6d7b7cf4455623ab2da7bfbdadabb0b4b3e3b81` (sin fetch nuevo; no se afirma sincronía) |
| Estado del directorio del plan antes de editar | parseo de `.git/index` v2 (1.090 entradas) y SHA-1 de blob de cada archivo, también con CRLF→LF | 13 rastreados, 12 sin seguimiento; con CRLF normalizado, modificados respecto al índice: CONTRATO, ESTADO, EVIDENCIA, README, T00-REVISION, TAREAS; resto igual |
| Protección previa | copia de los 25 archivos del plan en el espacio de trabajo de la sesión + SHA256 por archivo | 25/25 hashes registrados antes de editar; originales en disco no tocados hasta la copia final |
| Existencia de archivos futuros | listado de `src/`, `scripts/`, `cloud-server/` | no existen `scripts/catalog-check.cjs`, `cloud-server/catalog/`, `src/features/catalog/`, `src/features/library/catalog/` |
| AGENTS.md | listado de raíz, `docs/` e índice Git | ninguno encontrado |
| Validación documental | `python3 -I validate_plan.py <plan_nuevo> <copia_previa>` | PASS. 26 archivos UTF-8 estricto sin U+FFFD y EOL homogéneo; 25 MD con fences pares; 157 enlaces locales existentes; 725 líneas añadidas sin espacios finales ni marcadores; T00–T25 = 26 fichas con nombres iguales a TAREAS y responsables iguales a N1 (8/16/2); V00–V11 = 12 fichas con nombres iguales a plan B §8, 20 campos cada una y responsables iguales a N1 (1/3/8); gates solo G0–G4; sin IDs T>25 ni V>14; dependencias V sin padre posterior; cambios solo en los 5 archivos autorizados más 1 nuevo, todos aditivos; matriz T intacta |
| Correcciones durante la validación | primer run FAIL con 3 fallos | 2 eran defectos del script (orden V numérico tomado como orden topológico; fila «G0 antiguo» de N1 §3 contada como gate) y se corrigieron; 1 real (comando futuro sin etiqueta en V01 campo 10) corregido en la matriz V; segundo run PASS |
| Prueba negativa del validador | copia temporal con 4 defectos inyectados (campo faltante, enlace roto, espacio final, matriz T alterada) | FAIL con los 4 detectados |

No comprobado: `git status --short` y `git diff --check` reales, árbol completo fuera de este directorio, consistencia semántica más allá de la revisión manual registrada en la matriz V §2.

## E19. T01-B — cierre de contrato de hallazgos T01-A (2026-11-08)

Nivel ALTA, HEAD `a4462191aea29ffdae136f04e1fdc2e4024291d1`, rama LOCAL. Solo documentación del plan; sin código de producto, tests, fixtures, DDL, DB, red, Telegram ni `.env`. Respaldo previo verificado con SHA-256: `E:\777\app\BeatGaler-plan-backups\T01B-pre-20261108-124215` (4 archivos, `MANIFEST.sha256` OK).

Lectura estática que fundamenta las resoluciones: `library-trash-assets.js:7-48`, `library-beat-quota.js:16-45`, `library-index-publication.js:80-150`, `server-core.js:349-352,405-430,2620-2673,2738-2742`, migraciones `0001:167-189`, `0015:20-45`, `0018`, `direct-capability-boundary.js:12`, `capabilities.ts:40-80`, `AppShell.tsx:202,322-372,558-564`, `BeatCard.tsx:112,162,258`, `useLibraryReorder.ts`, `useTagRename.ts`, `usePlaybackQueue.ts`, `tauri.ts:402-406,563`, `webTransport.worker.ts:2545-2610`. `rg` de llamadores de `mergeCopyOnWriteGarbage(`: solo su definición; de `.deleteMessages(` en `src`: ninguno.

Hallazgo nuevo FX-01: `generate-fixtures.cjs:42` emite `schema: "galer-t-library"` en 24 fixtures; los lectores exigen `beatgaler.telegram.library` (`library-beat-quota.js:28`, `server-core.js:2561`, `webLibrary.ts:11`). No corregido en T01-B.

Artefactos: `contract-map.json` v2 sha256 `031001283303035c816870f90428a825130b7681ada17dcf882d94516a4a448c`; `consumer-map.md` sha256 `04efb0a1653e62a8d4389a2e4102fa945cb22a9de1b25d75f88ad689b927cc89`. Validación: JSON parsea, 18/18 stops con `t01b`, 69/69 paths con `sql_destination_c3`. No es PASS de T01; cobertura bidireccional pendiente de T01-C.

## E20. T01-C — fixtures y cobertura (2026-11-08)

Nivel MEDIA. HEAD `a4462191aea29ffdae136f04e1fdc2e4024291d1`, rama LOCAL. Solo se modificaron el generador, los fixtures sintéticos y los mapas del plan. No se tocó código de producto ni tests existentes, ni se usaron DDL, DB, red, Telegram o `.env`. Respaldo previo verificado con SHA-256: `E:\777\app\BeatGaler-plan-backups\T01C-20261108-130149` (fixtures + 5 docs).

| Comprobación | Comando o método | Resultado |
|---|---|---|
| Reproducibilidad | `node cloud-server/tests/fixtures/catalog/generate-fixtures.cjs --check` | `OK 53 fixtures reproducibles` |
| FX-01 contra el lector real | `library-beat-quota.indexRows` sobre cada INDEX de fixture, con entorno vacío (`env -i PATH`) | antes 30/30 rechazados por schema; después 0/41. Todos los `index-valid` son aceptados. Los REVIEW que el lector ya rechaza siguen rechazados (id-256, id-collisions, trash-unwrapped, id-astral, trash-beat-nonobject) |
| Oracles conservados | comparación de kind/expected/oracle/note de los 41 previos | 41/41 iguales. Única diferencia: el conteo `bytes=` embebido en `t01-over-rollback-budget` (16240136→16240147, dentro de (15 MiB, 16 MiB)) |
| Versión por lector | reglas de `versioning.rs:17-40` y `webTransport.worker.ts:2409` | v1: Rust ok, Web rechaza; null: Rust→v1, Web rechaza; v3: ambos rechazan. Coincide con los oracles |
| NUL | parse + `JSON.stringify` de `t01-nul-unprojected` | el archivo y `legacy_json` no tienen byte NUL; el roundtrip es exacto y el valor se recupera |
| JSON paths | recorrido de los paths de los fixtures contra los patrones de `json_paths` | 69/69 con fixture (46 enlazados en T01-C) y 0 sin destino |
| Rutas inversas | grafo require/import (312 módulos) desde `cloud-server/server.js` y `src/main.tsx` | 100/102 alcanzables; CS-045 (solo tests) y CS-046 (SQL) explicados. Las 13 alertas de línea se revisaron a mano: todas correctas |
| test_owner | referencia en 339 archivos de test, más revisión manual de CS-019, de los 8 nulos de Cloud y de CS-038 | 0 consumidores sin test ni `test_gap`; ningún valor previo borrado |
| COV-01 | lectura completa de `postgres-rollback-preparation.js`, `legacy-exporter.js`, `cutover-snapshot-bundle.js` y de sus callers | sin símbolos INDEX; CS-048/CS-049/CS-050; `unclassified=[]`, `global_without_contract=[]` |

Artefactos (SHA-256):

- `contract-map.json`: `4153c155e68cca38a85c73d024f8605f889f52df7bc393095589aae544dca9eb`
- `consumer-map.md`: `fd84d68dba981d6ab0098d464823a01b74e1a11197493e38ecc2c1023d8b4100`
- `manifest.json`: `9c99bc472ede70880ba5d1a6f2545b69ed9f66a6ae80fde3b970076aa2ff047e`
- `generate-fixtures.cjs`: `c9eff0f6329f02da83da20669351362c4e83b74b121c05fbd824a302db1a33cc`

Los scripts de validación quedaron fuera del repo (scratchpad de la sesión); no se añadieron auditorías ni ZIP.

No comprobado:

- Bibliotecas reales: requieren autorización y se miden en T22.
- Ejecución de tests que requieren PG (`project-access.integration.cjs`, `postgres-cutover.integration.cjs`): corresponde al arnés T02.
- La evidencia mecánica de tests no prueba cobertura de comportamiento; por eso existen los `test_gap`.

## E21. T02 — arnés aislado y comandos de verificación (2026-11-08)

Nivel MEDIA. HEAD `a4462191aea29ffdae136f04e1fdc2e4024291d1`, rama LOCAL. Archivos nuevos:

- Runner y manifiesto: `scripts/catalog-check.cjs`, `scripts/catalog-suites.json`.
- Helpers en `cloud-server/tests/helpers/`: `catalog-net-guard.cjs`, `catalog-test-db.cjs`, `catalog-test-descriptor.json`, `catalog-fake-transport.cjs` (con reloj fake), `catalog-fake-server.cjs`.
- Pruebas en `cloud-server/tests/catalog-harness/`: 5 de unit y 1 de integración.
- Harness de navegador en `tests/catalog-harness/`: doble del coordinator, instrumentación, config vite, wdio, spec y orquestador.
- Workflow `.github/workflows/catalog-checks.yml`: solo `workflow_dispatch`, no se disparó.

No se tocó código de producto ni tests existentes. Tampoco se usaron DB reales, `.env`, Telegram, AWS ni red externa, y no hubo commit ni push. Respaldo: `E:\777\app\BeatGaler-plan-backups\T02-pre-20261108-133527`.

| Comando | Resultado |
|---|---|
| `node scripts/catalog-check.cjs unit` | PASS: 6 casos, 34 tests, 0 fallos, 0 skips. Red: 0 intentos en los casos `deny`; el caso del servidor fake solo usó 127.0.0.1. Con `DATABASE_URL`/`PGPASSWORD` en el padre, ambos se descartan y solo se registra su nombre |
| `node scripts/catalog-check.cjs faults` | PASS: 9 tests del transporte fake (pausa, respuesta perdida, 403/404, recibo duplicado, worker muerto, retardo con reloj fake, metadata prohibida) |
| `node scripts/catalog-check.cjs web` | PASS (V01-B): build del harness + Chrome 152 headless. Login simulado y Gallery LOCAL real con 240 BeatCards del fixture `c12-f02-search` (paginador «1–240 of 241»). Registra UA, viewport 1424×749, DPR 1, zoom 1 y fuentes. Hosts observados: solo `127.0.0.1:4284`. Contadores de fetch, listeners, timers, observers, blob URLs y montaje de cards. Guard: 6 procesos, 0 bloqueos |
| `node scripts/catalog-check.cjs integration` | exit 3: `CATALOG_TEST_URL_MISSING`. No hay instancia dedicada fuera del job |
| `T03` y `perf` / `nope` | exit 4 (suite registrada sin casos) / exit 2 (suite inexistente) |
| `all-local` | exit 3: unit y faults pasan; se detiene en el prerequisito de integration |

Pruebas negativas V01-C cubiertas por la suite unit:

- Entorno contaminado: no llega al hijo y ningún valor se imprime.
- URL ajena: localhost, túnel 127.0.0.1, otro puerto, rol, base, parámetros o protocolo.
- Instance id ausente o libre.
- `DATABASE_URL`/`RESTORE_DATABASE_URL`/`PG*` → rechazo con 0 conexiones.
- Identidad de instancia distinta → 0 `CREATE`.
- Cleanup de DB ajena, doble, o con system_identifier/owner/marcador/sentinel distinto → 0 `DROP`.
- Suite inexistente, pending o aggregate con pending.
- Casos fuera de raíz, `postgres-live`, `--env-file`, `-r` o no-node.
- Skip, todo, archivo sin tests, fallo y exit ≠ 0.
- Red en suite `deny`: fetch, net, http, https, dns, dns.promises y tls bloqueados y contados.

Límites:

- El guard cubre las API de red de Node en procesos que heredan `NODE_OPTIONS`. Chrome queda limitado por `--host-resolver-rules`, que no bloquea IP literales; H4 verifica los hosts observados.
- El harness no prueba transporte real ni rendimiento.
- La Gallery LOCAL todavía lee metadata por la ruta legacy `getLibraryIndex`, que queda contada. La prohibición de metadata vía transporte se aplica en el fake de Node; en navegador aplica cuando la Gallery lea del catálogo (T08).
- La imagen `node:22-bookworm` del workflow se fija por tag; hay que fijar el digest antes del primer dispatch.
- `CATALOG_TEST_INSTANCE_ID` y la contraseña del service son de un contenedor efímero sin puertos publicados.

### E21-b. T02 integration en CI (2026-11-08)

- Push autorizado `c6d7b7c..eebb7ea..6a7e4b0` a LOCAL: 78 archivos de T01/T02 y la corrección de 2 archivos. Se construyó con índice temporal sobre el remoto, sin checkout, merge ni reset; HEAD local sin mover. Escaneo de secretos: 0 hallazgos. Blobs de fixtures = SHA del manifiesto.
- Workflows activados por el push: solo `catalog-checks` (`f0-0.20-secret-scan` es solo de `main`; el probe G0, solo de su propio YAML).
- Imagen Node fijada: `node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844`.
- Run 42519400428: unit y faults PASS, integration 1/2 (`42501 permission denied for table run_marker`). Corrección: `GRANT SELECT` al rol de prueba.
- [Run 42519548345](https://github.com/magosouljah/BeatGaler/actions/runs/42519548345): sentinel `16.15`/`en_US.utf8`; unit 34/34, faults 9/9, integration 2/2; red del caso: `dns.lookup postgres` + `net.connect postgres:5432`, 0 bloqueos; URL enmascarada en el log.
- Aviso: el runner histórico `T00-BASELINE-READONLY.ps1` del remoto solo admite el workflow G0. Si se reejecutara sobre este árbol, marcaría `catalog-checks.yml` como STOP-BASE. No se modificó (es una guarda).

## E22. T03 — esquema base y repositorio (2026-11-08)

- Commits `fb7ff97` y `8a192e6` sobre `b23ea3f`, con push fast-forward solo a LOCAL. Checksums 0001–0025 sin cambios; ninguna guarda histórica modificada. Workflows activados: solo `catalog-checks`.
- Run 42520640249: T03 integración 2/6 (bug `instrumentPool` + 3 errores de prueba).
- [Run 42520961552](https://github.com/magosouljah/BeatGaler/actions/runs/42520961552): unit 41/41, faults, integration y T03 PASS (integración 6/6, 0 skips).
- Precisión: `bpm_sort` en `double precision` + `bpm_sort_class` (A2 r4) en lugar del `numeric` de C3.
