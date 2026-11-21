# T11 — Contrato real de Telegram: fase A/MEDIA con fakes cerrados (2026-11-09)

**Alcance:** T11 según [TAREAS](TAREAS.md) §T11, [MATRIZ-T](MATRIZ-T-NIVELES-20261107.md) §T11, [CONTRATO](CONTRATO.md) C7.3–C7.8 y C10, y [NATIVO r2.1](NATIVO-POSTGRES-20261108.md) §8.6 (envío, recibo, reconcile y `random_id` **en el gateway**) y §5.0.3 (la revocación del token debe invalidar sesiones Bot API y MTProto abiertas). Base: `1c02469` (T10 PASS CI).

**Estado: fase A (ALTA: experimentos y límites) y MEDIA (harness seguro) entregadas. Fase B (sandbox real) → `STOP-APPROVAL`.** No se declara T11 PASS ni G2. Nada de lo que sigue es evidencia de proveedor: `evidence=FAKE`, `g2=NOT_PROVEN`.

## 1. Entregado

| Pieza | Archivo | Resumen |
| --- | --- | --- |
| Adaptador del gateway | `cloud-server/catalog/transport-gateway.js` | Sin importar el SDK (solo `crypto`): recibe `sdk = { Api, bigInt }` y un `client` (`invoke`, `uploadFile`). `randomIdToLong`/`longToText` (int64 con signo ↔ `BigInteger`, extremos exactos), `newRandomId`, `captionFor`/`parseCaption` (`catalog:v1 op=<operationId> part=<partKey>`), `buildSendMedia` (`InputMediaUploadedDocument` + `forceFile` + `randomId` explícito), `buildSearch` (`InputMessagesFilterDocument`, límite ≤100), `buildGetMessages` (`channels.`/`messages.`), `classifyError` (tabla C8/C7), `matchCandidates`/`reconcileDecision`, `receiptFromUpdates`, `createTelegramGateway` → `sendPart`, `verifyMessage`, `searchByRandomId` (interfaz del worker T10). |
| Servidor fake con forma gramjs | `cloud-server/tests/helpers/catalog-fake-mtproto.cjs` | Sesiones que comparten estado, `script()` por frontera (`flood`, `forbidden`, `loseResponse`, `disconnectBeforeEffect`, `pause`), `revokeBot` (cierra todas las sesiones del bot), `dedupWindowMs` y `legacyCanDelete` como **parámetros de hipótesis**. |
| Harness | `scripts/catalog-transport-contract.cjs` | `--mode fake` (10 experimentos E1–E10, informe JSON con versiones/hashes del SDK, tabla de errores y política de reenvío); `--mode sandbox` cerrado: exige `--descriptor` (`scope T11-SANDBOX`, `approvalId`, `approvedBy`, `botIds`, `vaultIds`, `expiresAt`, `production:false`) y `BEATGALER_T11_SANDBOX_APPROVAL=<approvalId>`; aun así termina en `STOP-ENV` porque el runner real no existe en este commit. Nunca lee `.env`. |
| Worker (T10) | `cloud-server/catalog/worker.js` | Respeta `error.transient` explícito del gateway; `TRANSFER_RECONCILE` pasa `operationId`/`partKey` al transporte. |
| Pruebas | `catalog-transport-gateway.test.cjs` (7), `catalog-transport-contract.test.cjs` (3) | Suite `T11` del runner (red denegada, sin PostgreSQL); casos añadidos a `unit` y `faults`; workflow incluye T11 en el push. |

## 2. Registro del SDK (paso 1, solo lectura)

| Campo | Valor |
| --- | --- |
| `cloud-server/package.json` | `telegram` `^2.26.22` |
| Instalado (`node_modules/telegram/package.json`) | `2.26.22` |
| Campo `Version.js` del paquete | `2.26.21` (discrepancia interna del paquete publicado; se registra, no se corrige) |
| Lock `telegram` | `sha512-EIj7Yrjiu0Yosa3FZ/7EyPg9s6UiTi/zDQrFmR/2Mg7pIUU+XjAit1n1u9OU9h2oRnRM5M+67/fxzQluZpaJJg==` |
| Lock `big-integer` | `1.6.52`, `sha512-QxD8cf2eVqJOOz63z6JIN9BzvVs/dlySa5HGSBH5xtR8dPteIRQnBxxKqkNTiT6jbDTF6jAfrd4oMcND9RGbQg==` |
| `package-lock.json` SHA-256 | `0a1edd44ee7b2f15845812a4467072ff2bba1744fb51a4d719a31bd15ac2d50e` |

Verificado offline con el SDK instalado: `messages.SendMedia` acepta `randomId: long` explícito (serializa 8 bytes con signo; `-2^63` y `2^63-1` exactos); los errores conocidos llegan como subclases (`FloodWaitError.seconds`, `*MigrateError.newDc`, `errorMessage` base) y los desconocidos como `RPCError` con el código TL: el clasificador cubre ambos.

## 3. Reglas fijadas y límites (fase A)

- **Identidad (C7.3):** `random_id` int64 con signo persistido antes del efecto y pasado al SDK; caption `catalog:v1 op=<id> part=<key>` sin secretos. **`random_id` no es consultable a posteriori**: solo aparece en `UpdateMessageID` de la respuesta del envío. La reconciliación busca por caption + remitente + tamaño (D-T11-1).
- **Recibo ≠ verificación (C7.4–5):** el gateway lee del proveedor tamaño, documento y remitente; `sha256` remoto queda `null` (no se descargan bytes en T11); `recordVerification` (T09) rechaza tamaño distinto. Un remitente distinto → `PROVIDER_SENDER_MISMATCH` (no transitorio).
- **Clasificación de errores:** `REJECTED` (FLOOD/SLOWMODE con `Retry-After`, FILE_REFERENCE/FILE_PART/MIGRATE → re-subir) = sin efecto, repetir con la misma identidad; `PERMANENT` (permisos, peer, media inválida) → BLOCKED; `REVOKED` (AUTH_KEY_*, SESSION_*, USER_DEACTIVATED, API_ID_INVALID, BOT_INVALID) → cerco; `DUPLICATE_IDENTITY` (`RANDOM_ID_DUPLICATE`) → RECONCILE; **todo lo demás (red, timeout, desconocido) → `UNCERTAIN` → RECONCILE** (fail-closed).
- **Reenvío (C7.8):** `RESEND_POLICY.uncertain = BLOCKED`. Tras un error RPC explícito se repite la misma identidad (ASSUMED por protocolo: el error es la respuesta a esa petición). Ningún reintento HTTP ni `random_id` nuevo resuelve una respuesta perdida.
- **Reconciliación (C7.7):** 0 coincidencias → incierto (no demuestra que no se envió; retry acotado, sin reenviar); 1 → adoptar; >1 → `AMBIGUOUS`/BLOCKED (nunca elegir ni borrar por intuición). La ventana real de deduplicación se mide en sandbox y **no se extrapola**.
- **Cercado (C10, §5.0.3):** una sesión antigua no revocada puede borrar mensajes propios (quitar admin no lo impide); por tanto el cercado efectivo exige revocar/rotar credenciales y apagar procesos antiguos **antes** de activar. Sin prueba real, G2 = FAIL.

## 4. Experimentos (fake) y lo que la fase B debe demostrar

| Id | Paso | Resultado fake | Qué debe probar el sandbox |
| --- | --- | --- | --- |
| E1 | 1 | PASS_FAKE | — (forma TL verificada con el SDK instalado) |
| E2 | 2 | PASS_FAKE | respuesta perdida real → búsqueda encuentra el mensaje por caption/remitente/tamaño |
| E3 | 2 | PASS_FAKE | FLOOD_WAIT real no crea mensaje; repetir con la misma identidad tras la espera |
| E4 | 2 | **REQUIRES_SANDBOX** | si el mismo `random_id` reenviado tras reconexión crea un mensaje nuevo o devuelve el mismo; ventana real por Direct y MASTER PROJECT |
| E5 | 2 | PASS_FAKE | mismo nombre/archivo distinto y recibos duplicados en el proveedor real |
| E6 | 3 | PASS_FAKE | recuperación de message/document id por `GetMessages` real |
| E7 | 4 | **REQUIRES_SANDBOX** | revocación del token invalida auth key MTProto ya emitida y Bot API abiertas; bot compartido de laboratorio; rotación vs revocación |
| E8 | 4 | **REQUIRES_SANDBOX** | alcance real de una sesión antigua: pin/edit/delete propios y ajenos |
| E9 | 2 | PASS_FAKE | — |
| E10 | 1 | PASS_FAKE | — |

**Fase B (STOP-APPROVAL):** requiere permiso explícito de Purp con bots/vaults/cuentas de prueba, nunca bots compartidos de producción. Entregable: informe con IDs redactados, ventana real de deduplicación, tabla de errores observada y procedimiento reproducible de corte; sin credenciales en repositorio ni logs. Hasta entonces, T12 puede avanzar con el fake del gateway **solo por encargo expreso** y sin PASS ficticio (MATRIZ-T §T11).

## 5. Decisiones

- **D-T11-1:** la reconciliación posterior se basa en el marcador caption + remitente + tamaño; `random_id` sirve para la deduplicación del proveedor en el envío, cuya ventana es una hipótesis hasta la fase B.
- **D-T11-2:** el gateway nunca calcula `sha256` remoto en T11; el hash declarado por el cliente no autoriza ni deduplica (C7.4).
- **D-T11-3:** modo sandbox del harness cerrado por descriptor + variable de aprobación y, aun aprobado, `STOP-ENV` hasta implementar el cliente real bajo revisión de Sol.
- **D-T11-4:** no se modifica el SDK ni se rotan bots por intuición (TAREAS §T11.1 y MATRIZ-T).

**Siguiente:** T12 (transferencias y PROJECT sobre operaciones) con el gateway fake inyectado; G2 permanece pendiente de la fase B.
