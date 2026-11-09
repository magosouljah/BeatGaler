# T13 — Cliente de mutaciones sin INDEX y V07-A (2026-11-09, encargo con fakes)

**Alcance:** T13 según [TAREAS](TAREAS.md) §T13, [MATRIZ-T](MATRIZ-T-NIVELES-20261107.md) §T13, [MATRIZ-V](MATRIZ-V-NIVELES-20261107.md) V07-A (pasos 1–5), [C12-V00-CIERRE](C12-V00-CIERRE-20261107.md) §4 y §6, [T07](T07-COMANDOS-20261109.md) §2 y [NATIVO r2.1](NATIVO-POSTGRES-20261108.md) §10 (T13 simplificada: mutaciones solo por catálogo; sin metadata message; strip ID3 conservado). Base: `9585286` (T12 CI PASS aislado). **Encargo explícito de Sol con fakes:** la composición de producto sigue **apagada** (AppShell, Drawer, GalleryChrome y el adaptador Web legacy no cambian; T16 monta la rama POSTGRES), T11 sigue NO PASS y G2 NO demostrado.

## 1. Entregado

| Módulo | Archivo | Resumen |
| --- | --- | --- |
| API de comandos | `src/features/library/catalog/catalogCommandsApi.ts` | Cliente tipado de los endpoints `delivered` de T07: `PATCH /beats/:id` (expectedVersion, If-Match, Idempotency-Key), `POST /beats/trash|restore` (≤50), conjuntos (`/query-sets`), selección server-side (`/selections`, `GET` con flags por residentes, `/ops` con CAS, `/release`), operaciones bulk (`POST /operations`, `GET`, `/cancel`, `/resume`), rename (`/tags/rename/preview`, `/tags/rename`), detalle SQL (`GET /beats/:id`). Siempre era/época + CSRF en escrituras; errores `CatalogApiError`. |
| Mutaciones | `catalogMutations.ts` | `patchBeat` (409 → resultado `conflict` tipado; nunca PATCH automático; retry = misma clave), `trashBeats`/`restoreBeats` (lotes ≤50 secuenciales; un conflicto detiene los siguientes y el reporte `CONFLICT` enumera no ejecutados), `bulkOverSelection` (BULK_TRASH/BULK_RESTORE: job server-side, nunca descarga la lista), `purgeTrash` (sin petición: `pending` hasta T15), `importBeat`/`replaceBeat` (preparación de archivos inyectable —strip ID3 del MASTER, ZIP del PROJECT— separada de la autoridad; partes con hash SHA-256 en streaming; MASTER/WAV/ARTWORK por capacidad y PROJECT por MASTER vía `catalogTransfer`; progreso por etapas `preparing/master/wav/artwork/project/library`; sin archivos nuevos → PATCH), referencias de operación **por cuenta** (`localStorage`, sin tokens) con `pendingOperations`/`resolvePendingTransfers` para recargar, `beatFromCatalogDetail` (DTO SQL → `Beat`), `metadataPatch` (solo campos cambiados). |
| InteractionStore (V07-A) | `catalogInteractionStore.ts` | Por cuenta, `useSyncExternalStore`. **Selección global**: Select All = conjunto READY del query/revisión + `defaultSelected=true` (count del servidor); individual = `default=false` + `INCLUDE/EXCLUDE_IDS`; Shift = `INCLUDE_RANGE` por extremos `beatId` (ancla fija hasta clic sin Shift); flags solo para residentes (RV4): un seleccionado evictado sigue seleccionado; deseleccionar todo → count 0 sin enumerar; filtros → borra con aviso «Selección borrada al cambiar los filtros» solo si count > 0; sort → conserva y reinicia ancla; revisión externa / CAS fallido → `conflict` y comandos deshabilitados. **Editor**: un draft con versión de origen y campos tocados; 409 conserva el texto; retry reutiliza la misma operación; `reloadEditorOrigin` adopta el origen fresco en los campos no tocados; `returnAnchor`. **Bulk** (Drawer): operación durable sobre la selección congelada, reporte total/confirmados/no ejecutados/lote en conflicto/cancelados; `completed` solo si todo confirmado; cancel no revierte; resume exige revisión explícita. **Drop**: identidad `beatId/version` capturada al inicio y cancelada si el target se desmonta. **Facetas**: cache LRU acotado por scope/q/revisión sobre `GET /facets`. **Rename**: preview (ACTIVE/TRASH, fusión) → confirmación → `TAG_RENAME` durable → progreso; parcial/conflicto nunca se presenta como éxito total. `teardown` por cuenta libera la selección. |
| Pruebas | `tests/helpers/catalogFakeCommands.ts`, `tests/component-dom/catalogMutations.test.ts` (5), `catalogInteractionStore.test.ts` (7) | Doble de servidor a nivel `fetch` con versiones, idempotencia, conjuntos BUILDING→READY, selección con flags/CAS/CONFLICT/FROZEN, operaciones por lotes con conflicto programable, transferencias (capacidad → PUT → commit 202/200) y espías legacy `get_index`/`replace_index`. Suite `T13` del runner (vitest loopback + typecheck). |

## 2. Reglas fijadas

- **Sin INDEX:** ninguna mutación POSTGRES lee ni publica el INDEX: los espías `getLibraryIndex`/`replaceLibraryIndex` quedan en 0 en todos los casos; la versión y los archivos salen del detalle SQL.
- **Conflictos:** 409 nunca se resuelve en silencio: el draft/los bytes se conservan, el usuario decide (recargar origen, guardar explícito, reseleccionar). Un reemplazo en conflicto devuelve `retained: true` (objetos nuevos sin vincular, C7.6).
- **Lotes:** ≤50 por petición; el conflicto de un lote detiene los siguientes y el reporte lo dice; ninguna transacción grande ni rollback masivo implícito.
- **Selección:** token/count/flags en el cliente, membresía en el servidor; nada se calcula sobre `windowItems`.
- **Referencias de operación:** por cuenta, sin tokens ni secretos; un checkpoint en memoria nunca marca una subida como exitosa (solo `COMMITTED` del servidor).
- **Purge:** la UI muestra «pendiente» hasta que T15 entregue el job durable; el cliente no envía PURGE.

## 3. Decisiones D-T13

- **D-T13-1:** la integración con `webBeatEdit.ts`, `webImportCommit.ts`, `webTrash.ts` y `webAdapter.ts` se hace por **puertos equivalentes** (`importBeat`, `replaceBeat`, `patchBeat`, `trashBeats`, `restoreBeats`) sin tocar los archivos legacy: la rama POSTGRES los sustituirá en la composición de T16; la preparación de archivos (`stripId3MetadataForCloud`, `prepareBrowserProjectArchive`) se inyecta en `prepareFiles` para no mezclar autoridad con preparación.
- **D-T13-2:** el editor conserva solo los campos tocados al recargar el origen tras un conflicto (los no tocados adoptan el valor actual), evitando sobrescribir lo que otro dispositivo cambió.
- **D-T13-3:** tras una operación bulk la selección se da por consumida (el servidor la deja FROZEN) y la UI vuelve a «sin selección» con el reporte visible.
- **D-T13-4:** `manualLibraryReorder` Web sigue `false`; no hay SortableContext ni reorden en la rama POSTGRES.

## 4. Resultados (LOCAL, FAKE)

`catalog-check T13` PASS (vitest `catalogMutations` 5/5, `catalogInteractionStore` 7/7, `catalogTransfer` 4/4, `catalogApi`, `TYPECHECK_PASS`); `runner.test` 9/9 (T03..T13 activas). Casos de TAREAS §T13.5 / V07 §13 cubiertos: conflicto preserva draft y no PATCH automático; retry misma operación; reload (referencias por cuenta y `resolvePendingTransfers`); cambio de cuenta; cuota (`QUOTA_EXCEEDED`, sin reintento); archivos retenidos tras conflicto; bulk desde Drawer con reporte por lote y conflicto tras el lote 2; stale bloquea; evictado sigue seleccionado; rename parcial nunca total; Shift por extremos; aviso condicional; sort conserva selección; drop por identidad; facetas acotadas; reorder = false. **No hay evidencia de proveedor ni activación de Gallery; V07-A queda implementada en módulos sin montar (PASS técnico aislado del encargo).**

## 5. Pendientes

Montaje en AppShell/Drawer/GalleryChrome y adaptador Web POSTGRES (T16, V08/V09); V07-B con audio (T14); artwork/playback por referencias (T14); purge durable (T15); evidencia real de proveedor (T11 fase B).

**Siguiente:** T14 (playback, artwork y descargas desde referencias SQL) con gateway fake.
