# T12 — Transferencias por capacidad y PROJECT sobre operaciones (2026-11-09, encargo con fakes)

**Alcance:** T12 según [TAREAS](TAREAS.md) §T12, [MATRIZ-T](MATRIZ-T-NIVELES-20261107.md) §T12, [CONTRATO](CONTRATO.md) C7.3–C7.9 y §PROJECT, y [NATIVO r2.1](NATIVO-POSTGRES-20261108.md) §8.6 (capacidad de transferencia opaca; el cliente nunca recibe token, chat ni `message_id`). Base: `2e76063` (T11 fase A). **Encargo explícito de Sol (2026-11-09): T12–T17 exclusivamente con gateway fake inyectado y entornos desechables.** Por tanto: **T11 sigue NO PASS, G2 NO demostrado**, y todo resultado de esta tarea se etiqueta **FAKE/aislado**; ningún gate queda superado.

## 1. Entregado

| Pieza | Archivo | Resumen |
| --- | --- | --- |
| Migración 0031 | `cloud-server/migrations/0031_catalog_transfer_capabilities.sql` | `catalog_transfer_capabilities`: solo el **hash** del token (como `direct_capabilities`), dirección `UPLOAD`/`PROJECT_UPLOAD`, `attempt`, estados `ISSUED→REDEEMED→CONSUMED|FAILED` (+`EXPIRED`/`REVOKED`), `outcome` (`SENT`/`UNCERTAIN` solo en `CONSUMED`; `REJECTED`/`UPLOAD_FAILED`/`BYTES_MISMATCH`/`ABORTED`/`PERMANENT`/`REVOKED`/`ACCESS_DENIED`/`SUPERSEDED` en `FAILED`), `bytes_size`/`bytes_sha256` (nivel **GATEWAY**). Aditiva, sin bytes de archivo, FK a `catalog_operation_parts`. |
| Transporte | `cloud-server/catalog/transport.js` | `issueUploadCapability` (una capacidad viva por parte; PROJECT → 400 `PROJECT_USES_MASTER`), `uploadPart` (secuencia C7, abajo), `uploadProjectPart` (PROJECT por MASTER), `listAttempts`; admisión de temporales propia (concurrencia + presupuesto, 503 `TRANSFER_BUSY` + Retry-After); `classifySendFailure` fail-closed. Solo SQL + crypto + fs; gateway y MASTER **inyectados**. |
| Rutas | `cloud-server/catalog/routes.js` | `POST /operations/:id/parts/:partKey/capability`, `PUT /transfer/upload/:token` (cuerpo = stream crudo), `PUT /operations/:id/parts/:partKey/project`, `GET /operations/:id/attempts`; `Retry-After` desde `detail.retry_after_ms`. Sin transporte montado → 501. |
| Operaciones (T09) | `cloud-server/catalog/operations.js` | `assignSender` (remitente solo antes del primer despacho → nuevo `random_id`, D-T09-4); `putReceipt` acepta `bytesSha256` (nivel GATEWAY) y rechaza remitente distinto cuando la identidad persistida es numérica; **corrección** en `claimJobs`: paréntesis en `(QUEUED … OR LEASED vencido) AND kind = ANY(...)` (antes el filtro de tipos no aplicaba a los QUEUED). |
| Gateway (T11) | `cloud-server/catalog/transport-gateway.js` | `botId` (identidad `transport_bots.id` ↔ id numérico del bot al verificar/buscar); envuelve `{name,size,path}` en `sdk.CustomFile` cuando el SDK lo expone (sin cargar el archivo en memoria). |
| MASTER | `cloud-server/direct-transport-control.js`, `cloud-server/catalog-project-master-adapter.js` | `publishProjectFile`/`findProjectFile`/`verifyProjectMediaFromClient` aceptan `caption` opcional (por defecto el formato legacy: sin cambio de comportamiento) y devuelven `senderId`/`sizeBytes`; nuevo `masterSenderId(chatId)`; adaptador fino `{ resolveSenderId, publishProjectFile }` **no probado contra el proveedor real**. La ruta legacy `/transport/project/upload`, `project-upload-authority.js` y la admisión quedan intactas. |
| Cliente Web | `src/features/library/catalog/catalogTransfer.ts` | `createCatalogTransfer`: `createOperation` (Idempotency-Key, era/época, CSRF), `uploadPart` (capacidad → PUT; reintento **solo** ante rechazo sin efecto con Retry-After y nueva capacidad; 202/`PART_UNCERTAIN` → nunca reenvía), `uploadProject`, `commit` (200 | 202 → observación hasta estado terminal | conflicto), `cancel`, `renewReservation`; SHA-256 incremental por trozos (`Sha256`, `sha256Hex`, `describePart`). Sin integración en UI (T13). |
| Pruebas | `catalog-transport.test.cjs` (8), `catalog-transport.integration.cjs` (7, PG), `tests/component-dom/catalogTransfer.test.ts` (4 vitest) | Suite `T12` del runner (descriptor PG + node_modules raíz) incluye además las suites PROJECT legacy (`project-upload-route`, `project-upload-admission`, `project-master-message`), typecheck y el caso `unit` nuevo. |

## 2. Secuencia C7 implementada (Direct por gateway)

1. **Capacidad** (SQL breve, cerco era/época): parte en `PENDING`/`DISPATCHED` y operación en vuelo; si existe un intento `UNCERTAIN` (o `REDEEMED` tras despacho) → 409 `PART_UNCERTAIN` y se asegura el job `TRANSFER_RECONCILE`; la capacidad anterior viva se revoca. Token de 32 bytes aleatorios, TTL 10 min, un solo uso.
2. **Redimir** (SQL breve): `ISSUED→REDEEMED` atómico; vencida → `EXPIRED` + 403; desconocida/usada → 403.
3. **Bytes al temporal** (sin SQL): tamaño + SHA-256 en streaming con tope = tamaño declarado. Exceso, tamaño o hash distintos → 409 `PART_BYTES_MISMATCH` (archivo reseleccionado distinto, C7.9) **sin efecto**; stream cortado → 400 `UPLOAD_ABORTED`; la parte sigue `PENDING` y `cancel` es limpio.
4. **Despacho** (SQL breve): `markDispatched` → misma `random_id` en reintentos (identidad persistida antes del efecto, C7.3).
5. **Envío por gateway** (sin SQL): `sendPart` con caption `catalog:v1 op= part=`. Clasificación: `REJECTED` (FLOOD/FILE_*) → 503 `SEND_REJECTED` + Retry-After, journal `FAILED/REJECTED`, siguiente capacidad conserva la identidad; `UPLOAD_FAILED` (p. ej. temporal perdido) → 503 sin efecto; `PERMANENT` → 403; `REVOKED` → 503 cerco; **`UNCERTAIN` o error desconocido → journal `CONSUMED/UNCERTAIN` + job `TRANSFER_RECONCILE` + 202** (`resend: BLOCKED`).
6. **Recibo** (SQL breve): `putReceipt` con `bytesSha256` → job `TRANSFER_VERIFY` (worker T10 verifica con el proveedor: nivel PROVIDER). Si el recibo no se persiste tras enviar → `RECEIPT_PERSIST_FAILED` 503 y reconcile (fail-closed).
7. **Commit** (T09): instala objetos `PRESENT`, ubicaciones `KNOWN`/**`PROVIDER`**, `checksum_sha256 = NULL` (el hash GATEWAY no se etiqueta como BYTES); replay devuelve lo mismo.

## 3. PROJECT por MASTER

`PUT /operations/:id/parts/:partKey/project` (solo partes `role = PROJECT`): Access (`resolveProjectAccess` → tope del plan) **antes** de recibir bytes (downgrade → 413 sin efecto ni journal); journal `PROJECT_UPLOAD` `REDEEMED` (intención durable) → temporal acotado por `min(plan, declarado)` con la admisión de PROJECT (concurrencia 1) → remitente MASTER numérico resuelto fuera de SQL y fijado con `assignSender` antes del primer despacho → `markDispatched` → publicación por MASTER con caption `catalog:v1` y `random_id` explícito → recibo con `senderId` MASTER. El bot verifica el mensaje con el remitente esperado literal; la reconciliación busca por caption + remitente + tamaño. La transacción legacy que abarcaba send/verify **no existe en la ruta nativa**; la ruta legacy no se modifica (D-T12-2).

## 4. Pruebas y resultados (LOCAL/LAB, FAKE)

- `catalog-transport.test.cjs` 8/8; runner `unit` 101/101 (18 casos), `faults` 16/16; `runner.test` 9/9 (T03..T12 activas, T13..T21 pendientes); `postgres-schema` 31 migraciones; vitest `catalogTransfer.test.ts` 4/4 (SHA-256 frente a `node:crypto` incluidas fronteras 55/56/63/64/65/119/120/128; reintento con Retry-After y nueva capacidad; 202/`PART_UNCERTAIN` sin reenvío; `PART_BYTES_MISMATCH`/403 sin reintento; commit con observación); `TYPECHECK_PASS`; suites PROJECT legacy 7/7 sin cambios.
- **LAB** (PG 18 propio de WSL, copias generadas): `catalog-transport.integration` **7/7**; `catalog-worker.integration` 4/4 y `catalog-operations.integration` 5/5 tras la corrección de `claimJobs`. Casos de TAREAS §T12.4: respuesta perdida en **reserve** (replay idempotente), **upload** (202 incierto → reconcile adopta el único mensaje, 0 reenvíos), **recibo** (`RECEIPT_PERSIST_FAILED` → reconcile), **commit** (replay); **conflicto de reemplazo** (versión ganadora intacta, objeto nuevo `STAGED` retenido sin vincular, 0 borrados); **downgrade** de Access (413 antes de bytes); **archivo reseleccionado distinto** (409 sin efecto, parte `PENDING`); **multipart** (2 partes → `size_bytes` total, 2 ubicaciones PROVIDER); **cancel durante upload** (stream abortado → `ABORTED`, `cancel` → `CANCELED`, reserva `RELEASED`, 0 temporales); **temporal perdido** (`UPLOAD_FAILED` sin reconcile, reintento envía una vez); **0 clientes SQL retenidos** durante el envío pausado; PROJECT con intención durable observada **antes** de publicar.
- **No demostrado:** proveedor real (deduplicación por `random_id`, revocación, alcance de sesión antigua): T11 fase B. El adaptador MASTER real y `masterSenderId` no se ejecutaron contra Telegram.

## 5. Decisiones D-T12

- **D-T12-1 (nivel de evidencia):** el SHA-256 calculado por el gateway sobre los bytes entregados al proveedor se guarda como nivel **GATEWAY** (journal + recibo) y **no** se escribe en `verified_sha256`/`checksum_sha256`; `verification_level` sigue `PROVIDER`; **BYTES** queda para lectura remota (T14/T19).
- **D-T12-2 (legacy intacto):** la ruta `/transport/project/upload` y `project-upload-authority.js` no cambian; el PROJECT nativo usa su propia ruta con el mismo mecanismo de temporal, Access y admisión. `direct-transport-control` solo gana un `caption` opcional y `masterSenderId`.
- **D-T12-3 (reenvío):** `RESEND_POLICY.uncertain = BLOCKED` también en el cliente: tras 202/`PART_UNCERTAIN` el cliente solo observa; solo un rechazo explícito sin efecto admite otra capacidad con la misma identidad; intentos acotados (5).
- **D-T12-4 (PROJECT sin token al cliente):** el PROJECT no usa capacidad opaca: el servidor registra el intento como journal `PROJECT_UPLOAD` ya redimido; el cliente sube por la ruta autenticada.
- **D-T12-5 (identidad del remitente):** `transport_bots.id` (p. ej. `Bot20`) sigue siendo la identidad persistida de las partes Direct; el gateway la traduce a su id numérico al verificar/buscar; MASTER se persiste numérico antes del primer despacho.

## 6. Pendientes de integración real y bloqueos

- Montaje en `server.js`/composición (`createCatalogTransport` + `createTelegramGateway` real + `createMasterProjectAdapter`): **T16** (arranque y cercado); hoy nada se monta en el servidor real.
- Sandbox T11 fase B (Purp) para E4/E7/E8 y G2; medición de latencia/costo del gateway (T20, D-N6).
- UI: integración de `catalogTransfer` en import/reemplazo (**T13**).

**Siguiente:** T13 (cliente de mutaciones sin INDEX) con el gateway fake inyectado, sin PASS ficticio.
