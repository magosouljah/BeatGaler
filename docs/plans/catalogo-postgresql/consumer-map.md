# T01 — Mapa de consumidores del INDEX

HEAD `a4462191`, rama LOCAL, 2026-11-08. Datos completos en [contract-map.json](contract-map.json). Fixtures en `cloud-server/tests/fixtures/catalog/`: 53 con manifiesto SHA-256 (T01-C), reproducibles con `--check`. Sin DB, red, Telegram ni `.env`. Estado T01: ver [ESTADO.md](ESTADO.md).

## Resumen

- Archivos inventariados: 879 (SHA de la lista `27be3c6a…`). Apariciones crudas: 540 productivas y 284 en tests.
- Cloud: 47 productivos {'adapt': 26, 'legacy-only': 18, 'derived': 3}; 13 operaciones C10; T01-C añade CS-048…CS-050, 0 sin clasificar.
- Web: 55 productivos {'adapt': 45, 'legacy-only': 9, 'derived': 1}; ámbito {'global': 34, 'window': 2, 'entity': 13, 'operation': 6}.
- JSON paths: 69. Versiones v1 (version ausente/1, solo lectura) y v2. v1 exporta sin pérdida solo como source-roundtrip; authoritative-export v2 es delta listado (version:2, trash:[]).
- Rename de tags: Web usa `Set` exacto (useTagRename.ts:78-81); Desktop trim+lowercase (commands.rs:13741). Desktop no se porta a Web.

## STOP de T01-A y cierre T01-B (ALTA, 2026-11-08)

T01-B cerró los 18 hallazgos con C1–C12 y r4, sin decisiones de producto nuevas ni código. Detalle verificable (evidencia path:línea, regla, tareas) en `stops[*].t01b` de [contract-map.json](contract-map.json). Clases: **EE** error existente en LEGACY (no se corrige aquí), **RM** riesgo de migración, **FP** fase posterior.

| ID | Tipo T01-A | Estado T01-B | Clase | Regla cerrada (resumen) | Tareas |
| --- | --- | --- | --- | --- | --- |
| D-01 | STOP-DATA | Cerrado | RM | Tombstone con `assets_known=false`: identidad permanente, nunca genera purge; posibles huérfanos quedan (fuga, no pérdida) | T03/T04/T15 |
| D-02 | STOP-DATA | Cerrado | RM | Ninguna representación es autoridad de borrado; `garbage[]` verbatim en `catalog_legacy_fields`; `garbage_journal` ni se importa ni se escribe; garbage ∩ ref viva → REVIEW | T04/T15 |
| D-03 | STOP-DATA | Cerrado | RM | `legacy_json` TEXT exacto (no jsonb) ⇒ `legacy_sha256` = beatHash legacy; nunca recalcular; PENDING bloquea corte; PURGED proyecta CONFIRMED en `library_trash_purges` | T03/T04/T15/T17 |
| D-04 | STOP-DATA | Cerrado | EE+RM | ABSENT = null u objeto sin escalares no nulos; con valores pero sin ref válida → OPAQUE; purge POSTGRES enumera desde SQL | T04/T15 |
| D-05 | STOP-DATA | Cerrado (rebajado) | RM | El colector incompleto es **código muerto** (sin llamadores); prohibido reutilizarlo; enumeración completa de partes en generaciones protegidas | T15/T25 |
| D-06 | STOP-DATA | Cerrado | RM+EE | ID string exacto; REVIEW si no string, con espacios en bordes, fuera de 1..256 (UTF-16 y PG), NUL/surrogate o duplicado; >192/charset ⇒ `direct_scope_compatible=false`, transfers fallan cerradas | T03/T04/T06/T09/T12 |
| D-07 | STOP-DATA | Cerrado | EE+RM | Trash sin wrapper importable (`wrapper_present=false`, campos NULL, export verbatim); sin ledger ⇒ REVIEW | T03/T04 |
| D-08 | STOP-DATA | Cerrado | RM | TEXT conserva todo vía escapes; NUL/surrogate en campo proyectado → REVIEW; claves duplicadas/enteros no seguros → REVIEW con parser estricto | T03/T04 |
| D-09 | STOP-DATA | Cerrado | RM | Tenant = `users.id`; mapa de topics solo evidencia de protección; discrepancia → REVIEW; `pendingTopicDeletes` vacío antes de FREEZE | T04/T05/T16/T17 |
| D-10 | STOP-DATA | Cerrado | RM+EE | size 0 ⇒ NULL proyectado; locator no `direct:` ⇒ OPAQUE; no fabricar `direct:<id>`; unión INDEX+SQL de tombstones | T04/T14/T15 |
| C-01 | STOP-CONTRACT | Cerrado, sin STOP | Desktop-only | Web tiene `manualLibraryReorder=false` (capabilities.ts:79, AppShell.tsx:350); POSTGRES no mueve manual_rank | T16 |
| C-02 | técnico | Cerrado | FP | Next/Prev = keyset sobre query vigente con ancla firmada **no ligada a revisión**; repeat/primero/último según r4 §2 | T06-A/T14 |
| C-03 | técnico | Cerrado | FP | Solo eventos autoritativos, 404/403 o cambio de cuenta/era liberan audio o cola | T08/T14 |
| C-04 | STOP-CONTRACT | Cerrado, sin STOP | Desktop-only | Upload YouTube/BeatGridPicker solo con `localHelper` (Web false) | T16 |
| C-05 | STOP-CONTRACT | Cerrado | legacy-only+FP | Matriz C10; compartición de purge por índice `catalog_part_locations(user_id,object_id)`; arranque por lotes con selección por autoridad SQL | T03/T13/T15/T16 |
| C-06 | hallazgo | Cerrado | EE + delta r4 I3 | Rename Web hoy no persiste (solo `setBeats`); POSTGRES implementa I3 aprobado | T07/T13 |
| S-01 | riesgo | Cerrado | EE | Catch de recover cercado en POSTGRES; cleanup-garbage se retira/cerca | T16/T25 |
| S-02 | plan B §3 | Cerrado | FP | Sin `Beat[]` completo en localStorage; vacío solo por contadores de context | T08/T16 |

**Hallazgos T01-C (cerrados en T01-C):** FX-01, FX-02, COV-01 y COV-02; ver [Cobertura (T01-C)](#cobertura-t01-c-media-2026-11-08). Texto original en `t01b.nuevos_hallazgos_para_T01C`.

### Contrato T01-B de filas, locks y fases

- **Precisiones C3:** `catalog_beats.legacy_json` TEXT + `legacy_sha256` + `direct_scope_compatible`; `catalog_tombstones.assets_known`; `catalog_trash_entries.wrapper_present`; `catalog_beat_tags.norm_key`.
- **Membresía (T03):** `catalog_query_sets` (predicado sin sort, `base_revision`, BUILDING→READY|STALE|FAILED|CANCELLED→RELEASED; una preparación por cuenta; compartido por owner/predicado/revisión), `catalog_query_set_leases`, `catalog_query_members` (slot denso por `beat_id ASC`, sin significado visible; FK a beats). READY usable solo si revisión/era/epoch coinciden.
- **Facetas (T03):** `catalog_beat_tag_groups` (una fila por beat×grupo, cuenta una vez) y `catalog_facets` (count + representante por `manual_rank`), mantenidas en la misma transacción.
- **Selección y bulk (T07):** `catalog_selections` (CAS), `catalog_selection_ops` (log append-only, última op gana, rango evaluado con su sort); materialización de rangos la decide T06-A. `catalog_operations` bulk + `catalog_operation_batches` (≤50, lote+checkpoint+mutaciones+revisión en una transacción) + `batch_items`.
- **Música (T14):** `catalog_playback_sessions`, `catalog_playback_commands` (seq CAS, replay idempotente), `catalog_shuffle_rounds/swaps/consumed`. **Cola manual: sin tabla**; paridad con hoy (memoria del cliente, IDs únicos uno a uno, no persistida), `MARK_PLAYED` la marca consumida en la ronda.
- **Orden de locks:** biblioteca (solo si cambia revisión/contadores/READY) → fila de control (set/selección/ronda/operación) → beats por ID → tag_groups/facetas por clave → archivos/objetos. Selección y Shuffle no toman la biblioteca. Lotes de construcción en REPEATABLE READ breve.
- **Fases DDL:** T03 base+membresía+facetas; T07 operaciones/eventos/selección/bulk; T09 partes/reservas/jobs; T14 música; T15 purge; T17 migration_runs. Ninguna FK hacia adelante.

## Consumidores Cloud

| ID | path:línea | símbolo | entrada | acceso | ámbito | clase | destino | test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CS-001 | cloud-server/library-index-publication.js:35 | `pinned` | internal (used by publish/recover/purgeTrash/verifyCommitted/migrateLegacyProjec | read | library-global | adapt | T05 | cloud-server/tests/library-index-publication.integration.cjs |
| CS-002 | cloud-server/library-index-publication.js:58 | `cleanupPrevious` | internal (publish, recoverAll) | delete-physical | operation | legacy-only | T25 | cloud-server/tests/library-index-publication.integration.cjs |
| CS-003 | cloud-server/library-index-publication.js:72 | `reserve` | HTTP POST /transport/quota/reserve | read-write | entity | adapt | T09 | cloud-server/tests/library-beat-quota.test.cjs |
| CS-004 | cloud-server/library-index-publication.js:83 | `ensureBootstrap` | HTTP POST /transport/index/commit | read-write | library-global | adapt | T04 | cloud-server/tests/fresh-vault-index-bootstrap.test.cjs |
| CS-005 | cloud-server/library-index-publication.js:88 | `preserveLegacyTombstones` | internal (recover) | write | library-global | adapt | T04 | cloud-server/tests/library-trash-purge.integration.cjs |
| CS-006 | cloud-server/library-index-publication.js:101 | `recover` | HTTP catch paths of POST /transport/index/publish and POST /transport/trash/purg | read-write | library-global | legacy-only | T16 | cloud-server/tests/library-index-publication.integration.cjs |
| CS-007 | cloud-server/library-index-publication.js:154 | `recoverAll` | startup (server.js:85 when cutover.authority==='postgres') | read-write | library-global | adapt | T16 | cloud-server/tests/startup-vault-recovery.test.cjs |
| CS-008 | cloud-server/library-index-publication.js:186 | `verifyCommitted` | HTTP POST /transport/index/commit | read | library-global | legacy-only | T05 | cloud-server/tests/library-index-publication.integration.cjs |
| CS-009 | cloud-server/library-index-publication.js:196 | `publish` | HTTP POST /transport/index/publish; internal from purgeTrash L493 and migrateLeg | read-write | library-global | legacy-only | T13 | cloud-server/tests/library-index-publication.integration.cjs |
| CS-010 | cloud-server/library-index-publication.js:419 | `purgeTrash` | HTTP POST /transport/trash/purge; startup recoverAll pending retry | delete-physical | library-global | adapt | T15 | cloud-server/tests/library-trash-purge.integration.cjs |
| CS-011 | cloud-server/library-index-publication.js:506 | `assertPurged` | HTTP POST /beats/delete-topics-batch, POST /beats/delete-topic, background flush | read | entity | adapt | T15 | cloud-server/tests/library-trash-purge.integration.cjs |
| CS-012 | cloud-server/library-index-publication.js:515 | `migrateLegacyProjectsOnce/migrateLegacyProjects` | startup (recoverAll L169/L178) | read-write | library-global | adapt | T12 | cloud-server/tests/project-access.integration.cjs |
| CS-013 | cloud-server/library-index-publication.js:604 | `renew/cancel/authorizeProject/uploadProject` | HTTP POST /transport/quota/renew, /transport/quota/cancel, /transport/project/au | read-write | entity | adapt | T09 | cloud-server/tests/project-upload-route.test.cjs |
| CS-014 | cloud-server/library-beat-quota.js:22 | `indexRows` | internal | read | library-global | derived | T04 | cloud-server/tests/library-beat-quota.test.cjs |
| CS-015 | cloud-server/library-beat-quota.js:48 | `readTelegramLibraryIndex` | internal (quota.bootstrap default readIndex) | read | library-global | legacy-only | T04 | cloud-server/tests/library-beat-quota.integration.cjs |
| CS-016 | cloud-server/library-beat-quota.js:129 | `bootstrap` | internal | write | library-global | adapt | T04 | cloud-server/tests/library-beat-quota.integration.cjs |
| CS-017 | cloud-server/library-beat-quota.js:171 | `reserve/renew/cancel/confirm/usage` | via CS-003/CS-013 | read-write | entity | adapt | T09 | cloud-server/tests/library-beat-quota.test.cjs |
| CS-018 | cloud-server/library-trash-assets.js:7 | `beatAssets/beatHash/messageIds` | internal | read | entity | derived | T15 | cloud-server/tests/library-trash-purge.integration.cjs |
| CS-019 | cloud-server/project-access.js:75 | `verifyChanges` | internal (publish L361) | read | library-global | adapt | T12 | cloud-server/tests/project-access.integration.cjs |
| CS-020 | cloud-server/project-upload-authority.js:28 | `upload/verifyPublished` | HTTP POST /transport/project/upload | read-write | entity | adapt | T12 | cloud-server/tests/project-upload-admission.test.cjs |
| CS-021 | cloud-server/server-core.js:2163 | `POST /transport/index/bootstrap-state` | HTTP POST /transport/index/bootstrap-state | read | library-global | legacy-only | T25 | cloud-server/tests/fresh-vault-index-bootstrap.test.cjs |
| CS-022 | cloud-server/server-core.js:2185 | `POST /transport/index/commit` | HTTP POST /transport/index/commit (wrapped by startup-routing-index attachCommit | write | library-global | legacy-only | T05 | cloud-server/tests/vault-index-pointer-store.test.cjs |
| CS-023 | cloud-server/server-core.js:2293 | `POST /transport/index/publish` | HTTP POST /transport/index/publish | read-write | library-global | legacy-only | T13 | cloud-server/tests/library-index-publication.integration.cjs |
| CS-024 | cloud-server/server-core.js:2316 | `POST /transport/trash/purge` | HTTP POST /transport/trash/purge | delete-physical | operation | adapt | T15 | cloud-server/tests/library-trash-purge.integration.cjs |
| CS-025 | cloud-server/server-core.js:3069 | `POST /beats/delete-topics-batch` | HTTP POST /beats/delete-topics-batch | delete-physical | operation | adapt | T15 | - |
| CS-026 | cloud-server/server-core.js:3122 | `POST /beats/delete-topic` | HTTP POST /beats/delete-topic | delete-physical | entity | adapt | T15 | - |
| CS-027 | cloud-server/server-core.js:409 | `flushPendingTopicDeletes/schedulePendingTopicDeletes` | worker (setImmediate background from routes) | delete-physical | operation | adapt | T10 | - |
| CS-028 | cloud-server/server-core.js:2725 | `POST /library/upsert, GET /library/get, POST /library/move-t` | HTTP (410 Gone) | read | operation | legacy-only | T25 | - |
| CS-029 | cloud-server/server-core.js:2738 | `POST /library/cleanup-garbage` | HTTP POST /library/cleanup-garbage | read | operation | legacy-only | T25 | - |
| CS-030 | cloud-server/server-core.js:2746 | `POST /library/artwork` | HTTP POST /library/artwork | read | entity | legacy-only | T14 | - |
| CS-031 | cloud-server/server-core.js:483 | `readLibraryManifestFromChat + migrateCurrentLibraryToTopics ` | none (no callers found) | read-write | library-global | legacy-only | T25 | cloud-server/tests/master-storage-recovery.test.cjs |
| CS-032 | cloud-server/server-core.js:1171 | `ensureEmptyIndexForStorage` | user-storage-lifecycle (L104) | read | library-global | legacy-only | T25 | cloud-server/tests/user-storage-lifecycle.test.cjs |
| CS-033 | cloud-server/direct-transport-control.js:1297 | `beginOperation (INDEX serialization get_index/replace_index)` | HTTP POST /transport/operation/begin (server-core.js:2061) | write | library-global | adapt | T16 | cloud-server/tests/direct-index-operation-document-context.test.cjs |
| CS-034 | cloud-server/direct-transport-control.js:1699 | `publishIndexBuffer/commitIndexCopyOnWrite` | internal (publish) ; commitIndexCopyOnWrite only from dead writeMigratedLibraryI | write | library-global | legacy-only | T25 | cloud-server/tests/master-index-flood-wait.test.cjs |
| CS-035 | cloud-server/direct-transport-control.js:1711 | `pinExistingIndexMessage` | internal (recover) | write | library-global | legacy-only | T25 | cloud-server/tests/library-index-publication.integration.cjs |
| CS-036 | cloud-server/direct-transport-control.js:1859 | `deleteMessages/deleteAndVerifyMessages` | internal | delete-physical | operation | adapt | T15 | cloud-server/tests/library-trash-purge.integration.cjs |
| CS-037 | cloud-server/direct-transport-control.js:1902 | `getPinnedMessage/readPinnedIndexBuffer/downloadMessageBuffer` | internal | read | library-global | legacy-only | T25 | cloud-server/tests/direct-message-download.test.cjs |
| CS-038 | cloud-server/direct-transport-control.js:732 | `restrictBotPinRights` | startup + session start via CS-040 | write | library-global | adapt | T11 | cloud-server/tests/direct-persistent-session-runtime.test.cjs |
| CS-039 | cloud-server/direct-capability-boundary.js:16 | `OPERATION_SCOPE_RULES get_index/replace_index/trash_*` | middleware (server.js installDirectCapabilityBoundary) + verifyAuthorizedCapabil | read | operation | adapt | T09 | cloud-server/tests/direct-capability-boundary.test.cjs |
| CS-040 | cloud-server/direct-index-pin-authority.js:9 | `ensure/ensureAll` | startup (server.js:84) + POST /transport/session/start (direct-persistent-sessio | write | library-global | adapt | T16 | cloud-server/tests/direct-persistent-session-runtime.test.cjs |
| CS-041 | cloud-server/startup-vault-recovery.js:3 | `skipMissingVault` | startup (recoverAll, ensureAll) | write | library-global | adapt | T16 | cloud-server/tests/startup-vault-recovery.test.cjs |
| CS-042 | cloud-server/vault-index-pointer-store.js:24 | `getForChat/compareAndSetForChat` | HTTP /transport/index/bootstrap-state, /transport/index/commit | read-write | library-global | legacy-only | T05 | cloud-server/tests/vault-index-pointer-store.test.cjs |
| CS-043 | cloud-server/startup-routing-index.js:281 | `POST /transport/routing/reconcile + session/start & index/co` | HTTP POST /transport/routing/reconcile; decorates POST /transport/session/start  | read-write | library-global | derived | T14 | - |
| CS-044 | cloud-server/atomic-library-index.js:53 | `installAtomicLibraryIndexBootstrap (/transport/index/ensure ` | HTTP POST /transport/index/ensure (410); coordinator unused in prod | read | library-global | legacy-only | T25 | cloud-server/tests/atomic-library-index.test.cjs |
| CS-045 | cloud-server/garbage-journal-repository.js + index-reconciliation.js + garbage-reconciliation-worker.js:3 | `enqueueGarbage/claimGarbageBatch/mark*, reconcileIndexObserv` | none (only tests require them) | read-write | library-global | adapt | T10 | cloud-server/tests/garbage-journal-repository.test.cjs |
| CS-046 | cloud-server/migrations/0015_library_beat_quota.sql, 0018_library_trash_purge.sql, 0001_control_plane.sql:29 | `library_beats (L29), library_trash_purges (L5), garbage_jour` | migration runner (postgres-migrations.js L69 table list) | write | library-global | adapt | T03 | cloud-server/tests/postgres-schema.test.cjs |
| CS-047 | cloud-server/http-containment.js:22 | `route allowlist incl. /transport/routing/reconcile` | middleware | read | operation | adapt | T06 | - |

## Consumidores Web

| ID | path:línea | símbolo | entrada | acceso | ámbito | clase | destino | test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WEB-001 | src/features/library/useLibraryState.ts:27 | `useState beats/setBeats` | App mount | read-write | global | adapt | T08 | - |
| WEB-002 | src/features/library/useLibraryState.ts:58 | `presentation cache debounce (localStorage)` | setBeats effect | write | global | adapt | T08 | tests/component-dom/accountIsolation.test.tsx |
| WEB-003 | src/features/library/libraryPresentationCache.ts:39 | `load/save library + sortBy cache` | startup bootstrap | read-write | global | adapt | T08/T16 | tests/component-dom/accountIsolation.test.tsx |
| WEB-004 | src/features/library/librarySelectors.ts:4 | `selectFilteredAndSortedBeats` | render | read | global | adapt | T06/T08 | tests/component-dom/galleryDesign.test.tsx |
| WEB-005 | src/app/useBeatGalerComposition.ts:627 | `displayedBeats = filteredBeats filtered by revealedBeatIds` | render | read | window | adapt | T08 | tests/component-dom/startupRevealArchitecture.test.ts |
| WEB-006 | src/features/startup/useLibraryReveal.ts:24 | `revealedBeatIds` | startup | read | global | adapt | T08/T16 | tests/component-dom/startupRevealArchitecture.test.ts |
| WEB-007 | src/app/useBeatGalerComposition.ts:624 | `tagFrequency = selectTagFrequency(beats)` | render | read | global | adapt | T06/T08 | tests/integration/libraryViewExtraction.test.ts |
| WEB-008 | src/app/useBeatGalerComposition.ts:625 | `allTags = selectAllTags` | render -> tag bar | read | global | adapt | T06/T08 | tests/integration/libraryViewExtraction.test.ts |
| WEB-009 | src/app/useBeatGalerComposition.ts:626 | `tagSuggestions = selectTagSuggestions` | edit drawer autocomplete | read | global | adapt | T06/T08 | tests/integration/libraryViewExtraction.test.ts |
| WEB-010 | src/components/BeatCard.tsx:335 | `sortBeatCardTags(beat.tags, tagFrequency)` | card render | read | entity | adapt | T08 | tests/integration/libraryViewExtraction.test.ts |
| WEB-011 | src/features/components/componentLogic.ts:35 | `tag sort by tagFrequency` | card render | read | entity | adapt | T08 | - |
| WEB-012 | src/features/design/GALLERY/GalleryChrome.tsx:12 | `allTags/filters bar` | render | read | global | adapt | T08 | tests/component-dom/galleryDesign.test.tsx |
| WEB-013 | src/features/tags/useTagRename.ts:31 | `affectedBeats / confirmTagRename` | user action: rename tag | read-write | global | adapt | T07/T13 | tests/integration/appTagRenameExtraction.test.ts |
| WEB-014 | src/features/selection/useBeatSelection.ts:14 | `selectedIds Set / toggleSelectAll(displayedBeats)` | user action: select | read-write | global | adapt | T09/T08 | tests/component-dom/beatSelection.test.tsx |
| WEB-015 | src/app/AppShell.tsx:172 | `displayedBeats.every(selected) / selectedIds.size` | render | read | global | adapt | T08 | tests/component-dom/beatSelection.test.tsx |
| WEB-016 | src/app/useBeatGalerComposition.ts:672 | `selectedBeats = beats.filter(selectedIds)` | bulk edit/upload | read | operation | adapt | T09 | - |
| WEB-017 | src/features/edit/useBeatEditing.ts:53 | `handleEditBulk / applyBulkUpdate` | user action: bulk edit | read-write | operation | adapt | T07/T09/T13 | tests/integration/appAuxiliaryModalExtraction.test.ts |
| WEB-018 | src/features/edit/useBeatEditing.ts:62 | `updateBeat / drawer commit` | user action: edit beat | read-write | entity | adapt | T07/T13 | tests/integration/appAuxiliaryModalExtraction.test.ts |
| WEB-019 | src/features/edit/webBeatEdit.ts:105 | `getLibraryIndex/replaceLibraryIndex CAS` | edit commit | read-write | global | legacy-only | T13 | tests/component-dom/webBeatEdit.test.ts |
| WEB-020 | src/features/trash/useTrashActions.ts:137 | `deleteBeat / handleRemoveBulk` | user action: delete/bulk remove | read-write | operation | adapt | T07/T13 | - |
| WEB-021 | src/features/trash/useTrashActions.ts:249 | `loadOfflineLibrary().then(setBeats).catch` | error recovery | write | global | adapt | T08/T16 | - |
| WEB-022 | src/features/trash/webTrash.ts:98 | `trash/restore/list via INDEX` | trash actions/panel | read-write | global | legacy-only | T07/T13 | tests/component-dom/webTrash.test.ts |
| WEB-023 | src/features/import/webImportCommit.ts:112 | `getLibraryIndex/replaceLibraryIndex` | import save | read-write | global | legacy-only | T09/T13 | tests/component-dom/webImportCommit.test.ts |
| WEB-024 | src/features/import/useImportSaveAll.ts:79 | `setBeats merge / review queueIds Set` | user action: save all import | read-write | operation | adapt | T09/T08 | tests/component-dom/importSaveAll.test.tsx |
| WEB-025 | src/features/import/useImportReview.ts:71 | `setBeats on reviewed save` | user action | write | entity | adapt | T08 | - |
| WEB-026 | src/features/library/webLibrary.ts:230 | `loadLibrary via getLibraryIndex` | startup / reload | read | global | legacy-only | T06/T08 | tests/component-dom/webLibrary.test.ts |
| WEB-027 | src/features/library/useLibraryReload.ts:112 | `reloadLibrary setBeats / offline fallback` | user action reload, reconnect | write | global | adapt | T08 | - |
| WEB-028 | src/features/library/useLibraryReorder.ts:34 | `drag reorder setBeats + setSortBy(manual)` | user action: drag | read-write | global | adapt | T07/T13 | - |
| WEB-029 | src/features/startup/useStartupBootstrap.ts:97 | `setBeats(offline)/setBeats([])/merge` | startup bootstrap | write | global | adapt | T08/T16 | tests/component-dom/startupBootstrap.test.tsx |
| WEB-030 | src/features/startup/useCloudLibraryRecovery.ts:25 | `restore if beats.length===0` | startup recovery | write | global | adapt | T16 | - |
| WEB-031 | src/features/session/useConnectivity.ts:66 | `setBeats on online/offline` | connectivity event | write | global | adapt | T08/T16 | tests/integration/appConnectivityCloudEventsExtraction.test.ts |
| WEB-032 | src/features/session/useSessionActions.ts:63 | `logout releaseFile+setBeats([])` | user action logout | write | global | adapt | T08 | - |
| WEB-033 | src/features/cloud/useCloudLibraryEvents.ts:98 | `SSE library event merge` | SSE event | write | window | adapt | T08 | - |
| WEB-034 | src/features/cloud/useCloudUploadQueue.ts:137 | `upload status setBeats map (12 sites)` | upload progress | write | entity | adapt | T09/T10 | tests/component-dom/activeUploadAuthority.test.ts |
| WEB-035 | src/app/useBeatGalerComposition.ts:283 | `active upload ids filter setBeats` | upload queue | write | entity | adapt | T09 | - |
| WEB-036 | src/features/cloud/useCloudBeatTransfer.ts:34 | `transfer update` | user action | write | entity | adapt | T12 | - |
| WEB-037 | src/features/projects/useBeatProjects.ts:116 | `project commit setBeats` | user action project | write | entity | adapt | T12 | - |
| WEB-038 | src/features/edit/useBeatAssetUpdates.ts:99 | `setBeats(refreshed) full replace` | artwork/audio update | write | global | adapt | T13/T14 | - |
| WEB-039 | src/features/artwork/useArtworkHydration.ts:47 | `artwork hydrate setBeats` | visible card | write | entity | adapt | T14 | tests/component-dom/artworkHydration.test.tsx |
| WEB-040 | src/features/offline/useOfflineAvailability.ts:73 | `toggle offline setBeats` | user action | write | entity | adapt | T08 | tests/integration/appOfflineAvailabilityExtraction.test.ts |
| WEB-041 | src/features/playback/usePlaybackController.ts:251 | `cloud_status update on ready` | playback | write | entity | adapt | T14 | - |
| WEB-042 | src/features/playback/usePlaybackQueue.ts:32 | `liveIds release on absence` | beats change | read | global | adapt | T14 | tests/integration/appMigrationCharacterization.test.ts |
| WEB-043 | src/features/playback/usePlaybackQueue.ts:37 | `playbackQueue = displayedBeats (+current)` | Next/Prev/ended | read | global | adapt | T14 | tests/integration/appMigrationCharacterization.test.ts |
| WEB-044 | src/features/playback/usePlaybackQueue.ts:59 | `shuffle random index over playbackQueue` | Next with shuffle | read | global | adapt | T14 | tests/integration/appMigrationCharacterization.test.ts |
| WEB-045 | src/features/playback/usePlaybackQueue.ts:98 | `queueIds / queuedBeats resolved via beats map` | user action add to queue | read-write | operation | adapt | T14 | tests/integration/appMigrationCharacterization.test.ts |
| WEB-046 | src/app/useBeatGalerComposition.ts:671 | `currentBeat = beats.find(playingId)` | player bar | read | entity | adapt | T14 | - |
| WEB-047 | src/app/useBeatGalerComposition.ts:673 | `activeDragBeat = beats.find` | dnd | read | entity | adapt | T08 | - |
| WEB-048 | src/components/UploadModal.tsx:1024 | `BeatGridPicker allBeats` | user action: bulk upload (YouTube) | read | global | adapt | T08/T09 | - |
| WEB-049 | src/features/publishing/usePublishingActions.ts:21 | `Array.from(selectedIds)` | user action upload bulk | read | operation | adapt | T09 | - |
| WEB-050 | src/features/cloud/webGalerCloudTransport.ts:250 | `getLibraryIndex/publishLibraryIndex runtimes` | all INDEX mutations | read-write | global | legacy-only | T13/T25 | tests/component-dom/webImportDurabilityFlow.test.tsx |
| WEB-051 | src/features/cloud/webTransport.worker.ts:2308 | `getLibraryIndex/replaceLibraryIndex` | worker message get_index/replace_index | read-write | global | legacy-only | T11/T25 | - |
| WEB-052 | src/features/cloud/webTransportWorkerClient.ts:481 | `getLibraryIndex/replaceLibraryIndex` | transport | read-write | global | legacy-only | T25 | - |
| WEB-053 | src/features/cloud/webTransportWorkerProtocol.ts:127 | `op get_index/replace_index` | worker protocol | read-write | global | legacy-only | T25 | - |
| WEB-054 | src/features/cloud/webTransportSession.ts:642 | `kind replace_index` | session | write | global | legacy-only | T25 | - |
| WEB-055 | src/lib/tagColors.ts:1 | `tag colors localStorage` | tag bar | read-write | global | derived | T08 | - |

## Contratos SQL

Existentes: library_beats (0015); library_trash_purges (0018: PENDING/CONFIRMED/LEGACY_TOMBSTONE); garbage_journal (0001); library_quota_state (0015); vault_index_pointers (0014).

Propuestos r4 §3 (nombres de contrato; sin DDL en T01):

- `catalog_query_sets` — T03 DDL / T06 / T09
- `catalog_query_members` — T03/T09
- `catalog_selections + exceptions/ranges (CAS selectionVersion)` — T03/T07
- `catalog_shuffle_rounds + swaps/inverse/consumed` — T03/T14
- `catalog_facets + representative` — T03/T06
- `catalog_queue (cola manual; limites pendientes T01-B)` — T03/T14
- `catalog_bulk_operations + batch results/journal/checkpoint/lease` — T03/T07/T10

## Cobertura (T01-C, MEDIA, 2026-11-08)

T01-B no cambió clases ni destinos; T01-C cierra fixtures y cobertura. Detalle por fila en `contract-map.json` (`t01c`, `consumers.*.test_evidence|test_gap|reachable_from_entry`, `json_paths[*].fixture_t01c`).

**FX-01.** `root()` del generador y los fixtures v1/version-null/version-future/raw-review usan ahora `schema: "beatgaler.telegram.library"`, el que exigen todos los lectores (`library-beat-quota.js:28`, `server-core.js:2561`, `webLibrary.ts:11`, `versioning.rs:6`, también para v1). `GENERATOR_VERSION` 2. Kind, expected, oracle y nota de los 41 fixtures previos no cambian; `t01-over-rollback-budget` solo cambia el conteo `bytes=` que lleva embebido (16 240 147, sigue entre 15 y 16 MiB). Con el lector real `indexRows`: antes 30/30 INDEX rechazados por schema, ahora 0/41.

**FX-02.** 12 fixtures nuevos, 53 en total:

| Fixture | Regla | Esperado |
|---|---|---|
| `t01-garbage-intersects-live` | D-02 | REVIEW (1100 vivo, 1102 en trash anidado); 1199 suelto no |
| `t01-topic-map-mismatch` | D-09 | REVIEW si mapa ≠ `telegram_topic_id` |
| `t01-topic-map-link-ambiguous` | D-09 | REVIEW si el enlace instalación→usuario es ambiguo o ajeno |
| `t01-id-trim-unpaired` | D-06 | REVIEW sin pareja recortada |
| `t01-id-astral` | D-06 | 😀×128 válido (sin scope Direct); 😀×129 y `a`×255+😀 REVIEW |
| `t01-trash-beat-nonobject` | D-07 | REVIEW |
| `t01-deleted-alias-conflict` | tombstones T01-B | REVIEW si difieren o faltan ambos; iguales no |
| `t01-live-vs-tombstone` | D-10/C1.11 | REVIEW |
| `t01-nul-unprojected` | D-08 | elegible; TEXT con escapes ASCII |
| `t01-manifest-toplevel-ref` | D-05 | referencia física en `manifest.telegram_*` además de `parts` |
| `t01-uploaded-files-beat-mismatch` | C4 (CONTRATO:99) | REVIEW; huérfano no |
| `t01-message-redirect-stale` | C4 (CONTRATO:99) | REVIEW si el oldId sigue en el INDEX |

`t01-version-null` confirmado `expected=review`. Los 69 JSON paths tienen fixture (46 enlazados en T01-C recorriendo los paths de los fixtures). C12-D01 queda cubierto por los fixtures de desconocidos, multipart, orden, tags, NUL, claves duplicadas y enteros no seguros; el roundtrip lo ejecuta T04.

**NUL.** Sin pérdida silenciosa con reglas ya aprobadas: `raw_index` bytea exacto por generación; `legacy_json` TEXT = `JSON.stringify` con escapes ASCII de U+0000 y surrogates sueltos, nunca jsonb (D-03/D-08); NUL o surrogate en campo proyectado → REVIEW; en campo no proyectado → elegible. Un byte NUL literal no es JSON válido → REVIEW. Precisión T01-C: la misma invariante TEXT aplica a `catalog_legacy_fields` y a extras de root, wrapper y garbage; el `root_extras jsonb` propuesto en T01-A queda sustituido. Si T03 eligiera jsonb para alguna columna legacy, NUL → REVIEW, nunca se elimina.

**COV-01.** Los tres archivos pertenecen al cutover del control-plane (accounts/cloud-data.json) y no tienen símbolos INDEX:

- CS-048: `assertJsonRollbackSnapshot`, que se ejecuta en el arranque (`server.js:79`).
- CS-049: export, commit y bundle. Es una herramienta de operador sin caller productivo.

Ninguno exporta `library_*`, `vault_index_pointers` ni `catalog_*`: T17/T19 definen su propia reversión y su propio backup. `uploadedFiles` y `messageRedirects` quedan en CS-050: no se importan, se cotejan con C4:99. Riesgo LEGACY no corregido: un `beatName` con U+0000 en `beatTopics` rompe `runtime_compat_state` (jsonb) bajo la autoridad PG del control-plane. `consumers.unclassified` queda vacío.

**COV-02.**

- CS-019 confirmado en `project-access.js:75`. Su caller es `library-index-publication.js:361` y el test indirecto pasa por `service.publish`; requiere PG, así que solo corre con el arnés T02.
- Rutas inversas: grafo de require/import sobre 312 módulos productivos desde `cloud-server/server.js` y `src/main.tsx`. 100/102 consumidores son alcanzables. CS-045 solo lo requieren tests, lo que coincide con lo declarado. CS-046 es SQL vía `postgres-migrations.js`. Las 13 alertas de línea eran falsos positivos y se revisaron a mano.
- `test_owner`: se conserva cuando hay evidencia (manual, o import más símbolo o ruta). Si se asignó por nombre o no existe test, se añade `test_gap` con la tarea propietaria. No se borra ningún valor previo.
  - Resultado: 2 verificados a mano sin gap, 37 por referencia mecánica y 63 con gap explícito, más 3 filas nuevas.
  - Los 8 nulos de Cloud: delete-topics-batch y delete-topic → T15; flush pendingTopicDeletes → T10; las 410 y cleanup-garbage → T25; artwork → T14; routing reconcile (helpers cubiertos, handler no) → T14; containment → cubierto.
- `global_without_contract` (WEB-028/042/043/048) queda vacío: lo cierran C-01…C-04 de T01-B.

Los fixtures no afirman cubrir bibliotecas reales.
