# Arquitectura del catálogo PostgreSQL — mapa técnico (E84, 2026-11-19)

Mapa breve para modificar el catálogo sin releer el historial. Decisiones de producto: [ESTADO](ESTADO.md); pruebas: [EVIDENCIA](EVIDENCIA.md).

> **Estado productivo actualizado al 20 nov 2026:** arquitectura PostgreSQL **LIVE**. [Cierre con evidencia AWS/SQL](CIERRE-LIVE-2026-11-20.md) · [deuda post-live](PENDIENTES-POST-LIVE-2026-11-20.md). Cloud `native-0e86aa42`, Web `native-1ceb9c39`, worker `beatgaler-catalog-worker.service` habilitado. La configuración legacy descrita al final ya **no es el flujo publicado**.

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
| `metadata-rules.js`, `name-uniqueness.js`, `beat-projection.js` | Reglas de metadatos, nombre único bajo lock y proyección del documento de beat a columnas SQL derivadas. Puros (salvo la consulta de nombre). |
| `commands.js` | Mutaciones de metadatos: PATCH, trash/restore, bulk, rename de tag, eventos. |
| `facets.js` | Proyecciones derivadas: grupos por tag y facetas por delta; reconstrucción completa (`rebuildDerivedProjections`) solo para cargas masivas/reparación. |
| `operations.js` | Transferencias C7 (IMPORT/REPLACE): intención, reservas de cuota, partes, recibos, commit; cola de jobs. |
| `direct.js` | Direct B: sesión del navegador, tickets/recibos de envío, lectura directa; nunca transporta bytes. |
| `prefix-packs.js` | Coordinación del MAIN (tickets de construcción, manifiesto); los bytes los sube el navegador. |
| `media.js`, `playback.js` | Acceso a medios por concesión; rondas Shuffle y vecinos de orden. |
| `purge.js` | Eliminación definitiva: fase de catálogo (TRASH→PURGED + manifiesto) y limpieza física por objeto (DELETED / conservado / diferido / REJECTED / UNCERTAIN). |
| `worker.js` | Ejecutor de jobs con lease y fencing (verificación, commit, reconciliación, conjuntos, purga). Transporte inyectado. |
| `transport-gateway.js` | Adaptador MTProto del Cloud (verificación, búsqueda, borrado y prueba de ausencia). SDK inyectado; sin bytes de archivos. |
| `backup.js` | Backup/restore SQL cifrado (G4); los medios no se copian aquí. |
| `session-guard.js`, `legacy-fence.js`, `flush-quarantine.js` | Cercos: capa 2 de sesión `catalog-v1`, error 410 para rutas INDEX sobre bibliotecas nativas, cuarentena del control-plane. |
| `native-cli.js` | CLI de operador (`inspect`/`activate`/`rebind-chat`/`reset`), dry-run por defecto. |
| `routes.js`, `api-manifest.json` | Router HTTP `/catalog/v1` (único módulo con express) y su contrato publicado. |

Dependencias: `routes` → módulos de dominio → `authority`/`contract`. Ningún módulo de `catalog/` importa red ni SDK (prueba de contrato «catalog/ no importa transporte ni red»).

## Cliente — `src/features/library/catalog/`

| Grupo | Módulos |
| --- | --- |
| Composición | `catalogComposition` (flag `VITE_CATALOG_API_ENABLED`), `LibraryCompositionGate`, `catalogLibraryProvider` (crea `CatalogServices`). |
| Datos | `catalogApi`/`catalogCommandsApi` (HTTP), `catalogQueryStore` (bloques residentes, sin cargar la biblioteca entera), `catalogFirstBlockCache`, `catalogInteractionStore` (selección, edición, bulk). |
| Sesiones de Gallery | `catalogQuerySession` (navegación, búsqueda diferida, facetas e invalidación tras mutaciones), `catalogImportSession` (revisión, progreso, provisionales y operaciones pendientes), `catalogPlaybackLink` (enlace entre la sesión de reproducción y `useAudio`, comandos de Playbar y cola). |
| Gallery | `CatalogAppShell` (pantalla), `useCatalogGalleryScope` (composición, suscripciones y estado de vista), `catalogGalleryCards` (DTO conocidos acotados, ordinales y portadas perezosas), `CatalogVirtualGallery` + `useCatalogVirtualRows` + `catalogRowGeometry` (rejilla virtual; `leadCards` = tarjetas de subida en curso). |
| Mutaciones y archivos | `catalogMutations` (PATCH/import/replace/purga), `catalogTransfer` (C7 por partes), `catalogFilePrep`, `catalogImportPlan`, `catalogBeatEditor` (guardado, reemplazo y papelera), `catalogProjectMerge`, `catalogDropKinds`/`catalogDropRouting`/`useCatalogFileDrop`, `catalogUploadProgress`, `catalogDownloads` (ID3 al descargar). |
| Direct B y medios | `catalogDirectCore`/`catalogDirectPort`/`catalogDirectTypes` (Worker MTProto; reanudable), `catalogLabDirectPort` (doble del LAB), `catalogMediaClient`, `catalogPrefixCache`, `catalogArtworkCache`, `catalogMainPack`, `catalogStreamSource` (MSE), `catalogLocalCaches` (Settings). |
| Reproducción y papelera | `catalogPlaybackSession`, `catalogPlaybackSets`, `catalogTrashSource`. |

### Editar un beat

`Drawer` → `CatalogAppShell` → `useCatalogGalleryScope` → `catalogBeatEditor`. El editor decide entre PATCH de metadatos y REPLACE de archivos según la intención. Al quitar la portada, confirma primero el PATCH y usa la versión confirmada para guardar los archivos pendientes. Para fusionar un archivo DAW, lee el PROJECT vigente por el cliente de medios. `catalogMutations` ejecuta el comando versionado. `catalogQuerySession` refresca Gallery y facetas según el resultado de la edición.

### Subir un beat

`AddBeatModal` → `CatalogAppShell` → `catalogImportSession`. La sesión administra revisión, resolución de archivos, progreso y tarjetas provisionales. Tras confirmar la revisión llama a `catalogMutations.importBeat` → `catalogTransfer`. Direct B envía los archivos del navegador a Telegram. Cloud recibe los recibos y registra la operación. El worker verifica y confirma el catálogo en PostgreSQL. La sesión refresca Gallery y retira la provisional cuando el beat real está en el bloque residente.

## Legacy que permanece (temporal)

El build público de producción tiene **`VITE_CATALOG_API_ENABLED=true`** y usa Gallery PostgreSQL; la composición antigua (`src/app/WebLegacyWorkspace.tsx`, `src/features/cloud/*`) y las rutas Cloud de INDEX/transporte (`POST /transport/project/upload`, `POST /transport/index/publish`) **siguen en el repositorio, pero no son el flujo nativo publicado**. Eran necesarias para la fase anterior al corte; **ahora se pueden planificar para retirada en T25**, después de inventariar dependencias y probar compatibilidad. No ejecutar retirada a ciegas ni volver a INDEX.

### Conexión del transporte en la instalación LIVE

- `catalog/native-transport-provisioning.js`: valida chat y activación, asigna un bot existente de forma durable, usa lock por vault, verifica membresía en Telegram y marca `ready` solamente con prueba.
- `direct-vault-assignment.js`, `direct-persistent-membership-runtime.js`, `direct-transport-control.js`: persistencia del bot, operación MASTER de membresía y proveedor Telegram.
- `catalog-worker.js` y `catalog/worker.js`: servicio **independiente del Cloud HTTP**, debe estar habilitado para hacer `TRANSFER_VERIFY` y `TRANSFER_COMMIT`. Su ausencia fue la causa del spinner tras las primeras 2 subidas; al arrancarlo se procesaron las 6 tareas sin reenvío de medios.
- `catalog-gateway-runtime.js`: resuelve bot por `vaults.transport_bot_id` con control de cuarentena/rotación; la activación de producción tiene modo `REUSED_UNROTATED` con riesgo residual expresamente aceptado, **no G2 PASS**.

Para diagnóstico actual usar [CIERRE-LIVE-2026-11-20.md](CIERRE-LIVE-2026-11-20.md), no asumir que Cloud HTTP 200 significa que el worker esté activo.
