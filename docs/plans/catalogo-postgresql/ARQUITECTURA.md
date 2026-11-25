# Arquitectura del catálogo PostgreSQL — mapa técnico (M8.5)

Mapa de la rama de integración de la limpieza V1. [Glosario](../../GLOSSARY.md) · [decisiones de interfaces M3–M4](../../adr/0001-interfaces-m3-m4.md) · [estado](ESTADO.md) · [evidencia](EVIDENCIA.md).

> El cierre productivo del 20 de noviembre de 2026 registra PostgreSQL **LIVE**, Cloud `native-0e86aa42`, Web `native-1ceb9c39` y el worker `beatgaler-catalog-worker.service` habilitado. [Cierre con evidencia AWS/SQL](CIERRE-LIVE-2026-11-20.md) · [deuda post-live](PENDIENTES-POST-LIVE-2026-11-20.md).

## Principios (vigentes)

- **PostgreSQL es la única autoridad** de metadatos y estado. Telegram guarda **solo medios**. El catálogo nativo no lee ni escribe INDEX.
- **Ningún byte de archivo del catálogo pasa por el Cloud**: todo archivo (MP3, WAV, portada, PROJECT, MAIN) viaja navegador ↔ Telegram por **Direct B**; el Cloud solo emite capacidades y confirma metadatos.
- **MAIN único por biblioteca**, construido en el navegador (prefijos para arranque y streaming). **Cachés persistentes** en IndexedDB: primer bloque de metadatos, prefijos MP3, portadas originales.
- **Eliminación definitiva** = salida del catálogo (PURGED) en SQL; la limpieza física en Telegram es posterior, durable e independiente.
- Integridad de envío **C7.8** (identidad persistida antes de cualquier envío, sin reenvío a ciegas). Temas de Telegram: cancelados.

## Servidor — `cloud-server/catalog/`

| Módulo | Responsabilidad |
| --- | --- |
| `contract.js` | Constantes y validadores compartidos (estados, roles, ids). Sin dependencias. |
| `authority.js` | Autoridad nativa: provisión explícita, era/época/revisión, `requireLibraryForMutation` (lock de biblioteca), guardas fail-closed. |
| `cursor.js`, `queries.js` | Lecturas: listado por keyset firmado, facetas, búsqueda (`search_text`, 0037–0039), conjuntos, navegación legacy de enlaces. Solo lectura. |
| `metadata-rules.js`, `name-uniqueness.js` | Reglas de metadatos y nombre único bajo lock. |
| `beat-projection.js` | Proyecta el documento a columnas SQL y arma DTO de lectura. Escribe filas, tags y deltas de facetas con el cliente SQL del llamador (M4.2). |
| `commands.js` | Mutaciones de metadatos: PATCH, trash/restore, bulk, rename de tag, eventos. |
| `facets.js` | Proyecciones derivadas: grupos por tag y facetas por delta; reconstrucción completa (`rebuildDerivedProjections`) solo para cargas masivas/reparación. |
| `operations.js` | Transferencias C7 (IMPORT/REPLACE): intención, reservas de cuota, partes, recibos y commit. Dueño del ciclo de vida de la cola. |
| `direct.js` | Direct B: sesión del navegador, tickets/recibos de envío, lectura directa; nunca transporta bytes. |
| `prefix-packs.js` | Coordinación del MAIN (tickets de construcción, manifiesto); los bytes los sube el navegador. |
| `media.js`, `playback.js` | Acceso a medios por concesión; rondas Shuffle y vecinos de orden. |
| `purge.js` | Eliminación definitiva: fase de catálogo (TRASH→PURGED + manifiesto) y limpieza física por objeto (DELETED / conservado / diferido / REJECTED / UNCERTAIN). |
| `worker.js` | Ejecutor de jobs con lease y fencing (verificación, commit, reconciliación, conjuntos, purga). Transporte inyectado. |
| `transport-gateway.js` | Adaptador MTProto del Cloud (verificación, búsqueda, borrado y prueba de ausencia). SDK inyectado; sin bytes de archivos. |
| `backup.js` | Backup/restore SQL cifrado (G4); los medios no se copian aquí. |
| `flush-quarantine.js` | Cuarentena del control-plane. El cerco `legacy-fence.js` se retiró en M6.2. |
| `native-cli.js` | CLI de operador (`inspect`/`activate`/`rebind-chat`/`reset`), dry-run por defecto. |
| `routes.js`, `api-manifest.json` | Router HTTP `/catalog/v1` (único módulo con express) y su contrato publicado. |

El router delega en los módulos de dominio, que usan `authority` y `contract`. La prueba `catalog-contract.test.cjs` inspecciona las importaciones de transporte y red.

### Ensamblado y gates (M4.1)

`cloud-server/catalog-assembly.js` concentra el ensamblado HTTP y del worker. HTTP configura autoridad con pool y control-plane PostgreSQL, y ensambla antes de que `server-core.js` monte el router. Direct y el gateway exigen en producción G2 aprobado o la excepción de riesgo aceptado. El ensamblado HTTP valida esa excepción con autoridad nativa habilitada y activación SQL `REUSED_UNROTATED`. El worker prepara el cutover, rechaza autoridad distinta de PostgreSQL o catálogo nativo apagado y comprueba disponibilidad antes de arrancar. Si falta el gateway, el worker reintenta verificación y reconciliación y MAIN devuelve 503 en operaciones que requieren verificador.

`cloud-server/catalog-boot.js` (M4.1b): `server.js` configura el arranque del catálogo antes de cargar `server-core.js`, que monta el router con `mountCatalog(app, authenticate)` (sin servicios: 503 `CATALOG_UNAVAILABLE`). La autoridad ya no es singleton (`createCatalogAuthority`); quedan pares `configure*/current*` en otros módulos (X53/X54, S1/S2 = 9).

### Transacción de biblioteca y cola (M4.3–M4.4)

`library-tx.js` concentra la política en `VARIANTS` por módulo e intención (`mutate`, `read`, `deriveWrite`, `continuePurge`). Aplica según el perfil disponibilidad, cuarentena, lock de biblioteca y era/época, congelación, aislamiento y plazos. El callback contiene el SQL de dominio.

| Variante | Entradas en `VARIANTS` |
| --- | --- |
| `commands`, `operations`, `playback` | `mutate`, `read` |
| `purge` | `mutate`, `continuePurge`, `read` |
| `direct` | `mutate` |
| `prefixPacks` (MAIN) | `mutate`, `read` |
| `media` | `read` |
| `queries` | `read`, `deriveWrite` |

D13.1/2 unifican las reglas SQL nativas en 409. D13.5 y D13.6 aplican cuarentena al manifiesto MAIN y a la escritura de conjuntos de consulta. D13.7 registra el mensaje interno de PostgreSQL en el servidor y lo omite del 503. D13.3 conserva Shuffle sin bloqueo por congelación, D13.4 conserva las lecturas de estado de transferencias, purgas y rondas durante cuarentena, y D13.8 conserva los presupuestos (MAIN 5 s por sentencia, 1 s por defecto y 2 s totales para la lectura de Gallery).

`tx.enqueue` inserta en `catalog_jobs` con el cliente de la transacción. La identidad `job_id` sostiene la deduplicación. `operations.js` reclama, renueva, completa y reprograma trabajos con lease y fencing. `worker.js` ejecuta los handlers y conserva la consulta SQL cruda de métricas. El worker también encola continuaciones por `operations.enqueueJob` en autocommit mediante `library-tx.js`. El INSERT de reconciliación en autocommit de `direct.js:57` queda fuera del envoltorio de encolado.

## Cliente — `src/features/library/catalog/`

| Grupo | Módulos |
| --- | --- |
| Composición | `catalogComposition` (flag `VITE_CATALOG_API_ENABLED`), `LibraryCompositionGate`, `catalogLibraryProvider` (crea `CatalogServices`), `catalogServiceLifecycle` (C12: preconexión Direct, MAIN y caché de conjuntos con `dispose`; orden de teardown fijo). |
| Datos | `catalogApi`/`catalogCommandsApi` (HTTP), `catalogQueryIdentity` (identidades de consulta con nombre: filtros, conjunto y filtros de reproducción), `catalogQueryStore` (bloques residentes, sin cargar la biblioteca entera), `catalogFirstBlockCache`, `catalogInteractionStore` (selección, edición, bulk). |
| Sesiones de Gallery | `catalogQuerySession` (navegación, borrador de búsqueda aplicado a los 250 ms, facetas e invalidación tras mutaciones), `catalogImportSession` (revisión, progreso, provisionales y operaciones pendientes), `catalogPlaybackLink` (enlace entre la sesión de reproducción y `useAudio`, comandos de Playbar y cola). |
| Gallery | `CatalogAppShell` (pantalla), `CatalogBeatCards` (`CatalogBeatCard` y `ProvisionalBeatCard`: fijan las props inertes de `BeatCard`), `src/app/galleryLocation.ts` (ubicación de Gallery fuera del ciclo de importación), `useCatalogGalleryScope` (composición, suscripciones y estado de vista), `catalogGalleryCards` (DTO conocidos acotados, ordinales y portadas perezosas), `CatalogVirtualGallery` + `useCatalogVirtualRows` + `catalogRowGeometry` (rejilla virtual; `leadCards` = tarjetas de subida en curso). |
| Mutaciones y archivos | `catalogMutations` (PATCH/import/replace/purga), `catalogTransfer` (C7 por partes), `catalogFilePrep`, `catalogImportPlan`, `catalogBeatEditor` (guardado, reemplazo, papelera y lectura del resultado; sustituye a los adaptadores `catalogAudioReplace`, `catalogArtworkReplace` y `catalogDrawerSave`, retirados en C2), `catalogProjectMerge`, `catalogDropKinds`/`catalogDropRouting`/`useCatalogFileDrop`, `catalogUploadProgress`, `catalogDownloads` (ID3 al descargar; `createGalleryDownloadsStore`, almacén observable de descargas por beat), `catalogFileKinds` (único normalizador de data URL → File, portada validada y detección de MASTER MP3). |
| Direct B y medios | `catalogDirectCore`/`catalogDirectPort`/`catalogDirectTypes` (Worker MTProto; reanudable), `catalogLabDirectPort` (doble del LAB), `catalogMediaClient`, `catalogPrefixCache`, `catalogArtworkCache`, `catalogMainPack`, `catalogStreamSource` (MSE), `catalogLocalCaches` (Settings). |
| Reproducción y papelera | `catalogPlaybackSession`, `catalogPlaybackSets`, `catalogTrashSource`. |

### Editar un beat

`Drawer` → `CatalogAppShell` → `useCatalogGalleryScope` → `catalogBeatEditor`. El editor decide entre PATCH de metadatos y REPLACE de archivos. Al quitar la portada con archivos pendientes, confirma primero el PATCH y relee la versión para el reemplazo. Para fusionar un archivo DAW, lee el PROJECT vigente por el cliente de medios.

**PATCH:** `catalogMutations` → `catalogCommandsApi` → `PATCH /catalog/v1/beats/:id` → `commands.patchBeat`. La transacción comprueba idempotencia y versión esperada. Si cambia el documento, escribe con `beat-projection.js`. Si cambia el documento o se desvincula la portada, actualiza la revisión y emite un evento. **REPLACE:** `catalogMutations.replaceBeat` usa el flujo de transferencia de abajo con beat y versión esperada. El commit actualiza los archivos y aplica los metadatos con el mismo escritor cuando procede. `catalogBeatEditor` interpreta el resultado y `catalogQuerySession` invalida la consulta y las facetas cuando corresponde.

### Subir un beat

`AddBeatModal` → `CatalogAppShell` → `catalogImportSession`. La sesión administra revisión, resolución de archivos, progreso y tarjetas provisionales. Al confirmar llama a `catalogMutations.importBeat` → `catalogTransfer`.

1. `POST /catalog/v1/operations` → `operations.createOperation` registra intención IMPORT, reserva y partes.
2. Por parte, `catalogTransfer` pide `send-ticket`. `direct.js` persiste la identidad del envío antes de devolver el ticket. Direct B envía los bytes a Telegram y la Web entrega `direct-receipt` al Cloud. `operations.putReceipt` registra el candidato y encola `TRANSFER_VERIFY`.
3. La Web pide `commit` y consulta la operación si sigue en curso. Si quedan partes por verificar, Cloud encola `TRANSFER_COMMIT` y devuelve 202. El worker verifica con el gateway y también puede encolar el commit cuando todas las partes están listas. `operations.commitOperation` confirma en PostgreSQL y usa `beat-projection.js` para insertar el beat de una IMPORT.
4. La sesión refresca Gallery. Si mostró una tarjeta provisional, la retira cuando el beat confirmado llega al bloque residente.

## Compatibilidad tras T25

La composición Web requiere el catálogo PostgreSQL. `LibraryCompositionGate` muestra el estado `legacy-retired` cuando la composición queda deshabilitada. El Cloud conserva cercos HTTP para rutas retiradas, incluidos literales de INDEX y PROJECT en `http-containment.js`. M6.2 retiró el Direct antiguo del Cloud (emisión y vista de capacidades, runtime de membresía, rutas y pruebas asociadas); se conserva la revocación de capacidades al cerrar sesión, cambiar la contraseña o borrar la cuenta (D21) en `direct-capability-boundary.js`.

### Cuentas y guardas HTTP (M7.2–M7.3, X69)

- `cloud-server/account-route-guards.js`: **tabla única** de guardas de cuentas y seguridad (prefijo y sufijo de rutas). `server-core.js` la monta sobre la instancia con `mountAccountRouteGuards(app)`; no se reasigna `express.application.use/post/get`.
- `accountLifecycle.api` (`cloud-server/account-lifecycle.js`): interfaz agrupada del ciclo de vida de cuentas; `provide()` registra las implementaciones al instalar los módulos, sin lecturas de `_test` en producción.
- Cuando la durabilidad no está disponible, el 503 de las rutas de sesión no emite cookies (X69).
- `cloud-server/auth-helpers.js` (M7.8): ayudantes únicos (email, bearer, sha256, ruta de `accounts-data.json`); las variantes que difieren conservan nombre propio.
- `cloud-server/identity-store.js` (M7.4a/b): índice en memoria del almacén de identidad en modo PostgreSQL (archivo virtual), reconstruido solo al confirmar el `rename`; cada lector recibe copia. Lo usan `session-security`, `account-lifecycle` y `http-containment`. En modo json se sigue leyendo el disco. Cada proceso tiene su propio almacén (X87).
- Persistencia: los filtros de cuentas borradas (`account-lifecycle`, B8) y de registro público (`auth-public-registration-hardening`, B8b) **fallan cerrados** (`ACCOUNT_LIFECYCLE_FILTER_FAILED` / `AUTH_REGISTRATION_FILTER_FAILED`).
- `cloud-server/runtime-env.js` (E2/E2b): nombra las variables de entorno; las fábricas reciben `env` explícito del compositor (`requiredEnv` lanza si falta).
- `server-core.js` no escucha al importarse: `server.js` llama a `listenCloudServer()` tras el require (M7.5a).
- Web: `src/features/auth/webFetchBoundary.ts` (M7.7b) es el **único** reemplazo de `window.fetch` (coordinador CSRF → frontera de credenciales solo Web → nativo; contrato X86 fijado en `webFetchPatchChain.contract.test.ts`); `webSession.ts`/`webSignIn.ts` (M7.7a) concentran la sesión Web.

### Conexión del transporte en la instalación LIVE

- `catalog/native-transport-provisioning.js`: valida chat y activación, asigna un bot existente de forma durable, usa lock por vault, verifica membresía en Telegram y marca `ready` solamente con prueba.
- `direct-vault-assignment.js`, `direct-transport-control.js`: persistencia del bot, operación MASTER de membresía y proveedor Telegram (`direct-persistent-membership-runtime.js` se retiró en M6.2).
- `catalog-worker.js` y `catalog/worker.js`: servicio **independiente del Cloud HTTP**, debe estar habilitado para hacer `TRANSFER_VERIFY` y `TRANSFER_COMMIT`. Su ausencia fue la causa del spinner tras las primeras 2 subidas; al arrancarlo se procesaron las 6 tareas sin reenvío de medios.
- `catalog-gateway-runtime.js`: resuelve bot por `vaults.transport_bot_id` con control de cuarentena/rotación; la activación de producción tiene modo `REUSED_UNROTATED` con riesgo residual expresamente aceptado, **no G2 PASS**.

Para diagnóstico actual usar [CIERRE-LIVE-2026-11-20.md](CIERRE-LIVE-2026-11-20.md), no asumir que Cloud HTTP 200 significa que el worker esté activo.
