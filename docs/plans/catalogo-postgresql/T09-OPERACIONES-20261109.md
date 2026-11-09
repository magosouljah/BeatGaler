# T09 — Intenciones de transferencia, reservas y máquina de estados (2026-11-09)

**Alcance:** T09 según [TAREAS](TAREAS.md) §T09, [MATRIZ-T](MATRIZ-T-NIVELES-20261107.md) §T09, [CONTRATO](CONTRATO.md) C1.10, C3, C7 y C8, y [NATIVO r2.1](NATIVO-POSTGRES-20261108.md) §10 (T09 simplificada: sin ledger legacy ni bootstrap desde INDEX; cuota por contadores) y §8.6 (el cliente nunca recibe chat ni token: el envío real lo hace el gateway de T11). Manifiesto `api-manifest.json` v3. No activa transferencias reales ni simula proveedor.

## 1. Entregado

| Pieza | Archivo | Resumen |
| --- | --- | --- |
| Migración 0030 | `cloud-server/migrations/0030_catalog_transfer_operations.sql` | `catalog_transfer_operations` (IMPORT/REPLACE/PURGE, estados C7 con trigger de transición: terminales inmutables, RECONCILE/BLOCKED nunca saltan a COMMITTED sin READY), `catalog_operation_parts` (identidad de envío: `random_id` int64 texto `UNIQUE (sender_id, random_id)`, sender, chat, partKey, tamaño y hash declarados; recibo y verificación en campos separados), `catalog_reservations` (HELD/CONSUMED/RELEASED/EXPIRED, 15 min renovables, tope 24 h), `catalog_jobs` (QUEUED/LEASED/DONE/FAILED/BLOCKED, `lease_generation` creciente). Aditiva, solo TEXT, sin bytes de archivos. |
| Operaciones | `cloud-server/catalog/operations.js` | `createOperation` (IMPORT/REPLACE), `markDispatched`, `putReceipt`, `recordVerification` (fencing de lease/época), `commitOperation` (202/200/409), `cancelOperation` (CANCELED o RECONCILE), `renewReservation`, `readmitReservation`, `expireReservations`, `getOperation`; jobs: `enqueueJob`, `claimJobs`, `renewJobLease`, `completeJob`, `failJob`, `backoffMs`. |
| Rutas | `cloud-server/catalog/routes.js` | `POST /operations` (IMPORT/REPLACE; PURGE → 501), `PUT /operations/:id/parts/:partKey/receipt`, `POST /operations/:id/commit`, `/cancel` (prefijo `top-` → transferencia, `op-` → bulk), `/reservation/renew`, `/reservation/readmit`, `/parts/:partKey/dispatch` (gateway). Cabeceras C5 obligatorias en escrituras. |
| Cuota | `server.js` | `resolveAccess(userId)` = `accessRuntime.resolveUserAccess({id}).quotas.max_beats` (null = sin límite). Nunca `library_beats`/`library_quota_state`/INDEX. |
| Pruebas | `catalog-operations.test.cjs` (3), `catalog-routes.test.cjs` (+1), `catalog-operations.integration.cjs` (5 tests PG) | Suite `T09` del runner; incluida en el push de `catalog-checks`. |

## 2. Reglas fijadas (C7/C8/C1.10)

- **Admisión (IMPORT):** bajo el lock de la biblioteca: cuota `active+trash+purging+pending < max_beats`, tombstone, Access; `beat_id` generado por el servidor (`b-<uuid>`, alcance Direct); reserva `BEAT_SLOT` HELD y `pending_count+1` (cuenta una vez, se consume una vez). **REPLACE:** beat ACTIVE con `expectedVersion`; versiones nuevas `STAGED` visibles como tales, la vigente sigue `VERIFIED`.
- **Identidad de envío (C7.3):** cada parte persiste `random_id` (int64 firmado, uniforme, texto), `sender_id` (bot del vault), `chat_id` (CURRENT), `partKey`, tamaño y hash declarado **antes** de cualquier efecto. El mismo retry (`markDispatched`) recupera la misma identidad; una operación nueva obtiene otra.
- **Recibo ≠ verificación (C7.4–5):** el recibo del cliente queda como candidato (`RECEIPT`); sender/chat/tamaño incoherentes → `RECEIPT_CONFLICT`; mismo recibo → replay; distinto → 409. La verificación del proveedor (`recordVerification`, T10/T11) exige lease vigente (owner + generación) y época; todas las partes `VERIFIED` → `READY`.
- **Commit (C7.6–7):** idempotente; 202 si falta verificación; revalida versión/estado, Access/cuota y reserva; instala objetos `PRESENT` (solo tras verificación), partes, ubicaciones `KNOWN`/`PROVIDER`, versión `VERIFIED` y slot actual; retira la anterior (`RETIRED`, `retained_until` +35 d); `active_count+1`/`pending_count−1`, reserva `CONSUMED`, evento y resultado en la misma transacción. Conflicto de versión → `CONFLICT` persistido con objetos nuevos sin vincular; replay tras `COMMITTED` devuelve lo mismo sin segunda instalación.
- **Cancel (C7.7–8):** nunca revierte `COMMITTED`; con despacho/recibo/verificación → `RECONCILE` (objetos retenidos, reserva HELD); sin envío → `CANCELED`, reserva `RELEASED`, `STAGED` retirados. Reenviar sin la prueba de T11 queda `BLOCKED`, no automático.
- **Reserva (C7.1):** `renew` +15 min hasta `max_until` (24 h); vencida → el commit responde `RESERVATION_EXPIRED` sin borrar bytes; `readmit` libera la plaza vencida, re-comprueba la cuota y crea una reserva nueva; `expireReservations` libera plazas vencidas por lotes (T10 lo programa).
- **Jobs (C8):** `claimJobs` con `FOR UPDATE SKIP LOCKED`, lote ≤10, lease 60 s, `lease_generation+1`, COMMIT antes de ejecutar; `renew` en transacción propia; `complete/fail` con fencing por owner+generación (resultado de worker viejo → `LEASE_FENCED`); backoff exponencial con jitter ≤15 min, `Retry-After`/FLOOD_WAIT mayor manda; 8 transitorios → `BLOCKED`; permanente → `BLOCKED` inmediato.

## 3. Decisiones D-T09

- **D-T09-1:** para IMPORT el beat y sus `catalog_file_versions` se crean en el commit (no hay estado de beat "pendiente" en C3); las partes STAGED viven en `catalog_operation_parts`. REPLACE sí crea versiones `STAGED` al preparar (C7.2).
- **D-T09-2:** PURGE responde 501 hasta T15 (purge lógico/físico, items y journal); la máquina C7 ya lo admite como `kind`.
- **D-T09-3:** `random_id` se genera con 8 bytes aleatorios (`readBigInt64BE`), uniforme en todo el rango int64, y se expone al gateway solo en `dispatch`; nunca al cliente.
- **D-T09-4:** la identidad del remitente es `vaults.transport_bot_id`; el gateway de T11 decidirá el reparto sobre el pool y podrá reasignar sender antes del primer despacho (nueva identidad = nuevo `random_id`), nunca después.
- **D-T09-5:** `expected_version` del REPLACE se revalida en el commit contra la versión actual; el PATCH/REPLACE ganador no se sobrescribe (C7.6).

## 4. Fuera de T09 (adscrito)

Bucle del worker, limpieza de reservas/leases abandonados y recuperación integral (T10); envío real, verificación del proveedor y reconciliación con `random_id` en el gateway, revocación de token (T11); PROJECT y transferencias del cliente por capacidad (T12); purge (T15).
