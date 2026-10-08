# Fase 3 — STEP 0: contrato de lanzamiento Billing V1 Web

**Base auditada:** `integration-v0.9.0-alpha.4` @ `c8495f2a52cb97278392e15c9f64cddab86b9cc7`; `origin` en el mismo SHA y working tree limpio antes de este documento. Fase 2: **CLOSED**. Fecha: 2026-10-08. Este estado describe el código de esa base, no una promesa de lanzamiento.

## Alcance y decisiones V1 congeladas

| Plan | USD/mes | Beats activos + Trash | PROJECT ZIP nuevo | Early Access |
| --- | ---: | ---: | --- | --- |
| Free | 0 | 20 | No; conserva y puede descargar el existente | No |
| Paid Entry | 6.99 | 100 | Sí, máximo 1,000,000,000 bytes | No |
| Highest Paid | 11.99 | Sin límite comercial | Sí, máximo 1,900,000,000 bytes | Sí |

- **Web es V1.** `WEB_FOUNDATION_CAPABILITIES.youtubePublishing=false`; la UI de YouTube/Bulk depende del helper Desktop. YouTube y Bulk quedan fuera del gate de lanzamiento Web y no deben anunciarse allí. Sus cuotas declaradas en la política no prueban disponibilidad Web. Anual no se vende: precio y política pendientes.
- Welcome: grant interno Paid Entry de 7 días, una vez al activar/verificar la cuenta; no es trial del proveedor y una compra pagada no retrasa el cobro. En PostgreSQL V1 lo emite Access tras verificación de email o identidad OAuth confirmada; el modo JSON legacy conserva su comportamiento anterior.
- Pago confirmado, no redirect ni estado del proveedor, habilita el período. Cambio Paid Entry ↔ Highest Paid en el próximo período **pagado**, sin prorrateo inmediato. Cancelación normal o downgrade a Free al fin de cobertura pagada. Renovación fallida: 7 días de grace desde `past_due_at`, sin elevar un upgrade pendiente.
- Downgrade, cancelación y refund no borran datos. Beats existentes siguen utilizables; si activos + Trash exceden el nuevo cupo, se bloquean identidades nuevas hasta volver bajo cuota. Free conserva PROJECT pero no puede subirlo ni reemplazarlo. Refund completo confirmado del período vigente revoca esa cobertura; parcial no la revoca por defecto; refund histórico no revoca otro período vigente.
- Sin límite **comercial** de dispositivos o sesiones en V1. Controles técnicos y de seguridad siguen independientes. `plans.js` aún expone límites comerciales y tamaños PROJECT distintos: no es el contrato de venta.
- Trash cuenta en el cupo. El Web actual ofrece move/restore/purge manual y escribe `purge_after` a 14 días; no hay prueba de purge automático. Ningún evento Billing debe provocar purge.

## Estado STEP 0–15

No había una enumeración STEP 0–15 en el repositorio auditado; esta tabla fija el **mapa operativo Web** para Fase 3. `PASS` exige pruebas del alcance completo de la fila; módulos aislados con pruebas quedan `PARTIAL` cuando falta integración o E2E.

| STEP | Gate | Estado | Evidencia / pendiente decisivo |
| ---: | --- | --- | --- |
| 0 | Base, alcance y gates congelados | **PASS** | SHA/árbol comprobados; este contrato y auditoría. |
| 1 | Ownership de grants entre Auth y PostgreSQL | **PASS** | Auth ya no escribe `entitlements`; Access importa legacy sólo antes de `READY` y emite welcome con unicidad durable. Regresiones PostgreSQL, restart, concurrencia, Auth y cutover verdes. |
| 2 | Resolver V1 como autoridad runtime única | **PARTIAL** | `billing-access-resolver.js` probado; `/plans/me`, `/plans/catalog` y payload Auth aún usan `plans.js`; Billing no está montado. |
| 3 | Cuota real de beats, incluidos Trash y concurrencia | **NOT STARTED** | 20/100/null sólo figuran en catálogos; no hay conteo/reserva autoritativa en commit Web. |
| 4 | Enforcement en operaciones reales y Direct/capabilities | **NOT STARTED** | Direct valida identidad/scope de operación, pero no plan/cupo en import, edit, upload o reemplazo de INDEX. |
| 5 | PROJECT Web según plan y bytes | **PARTIAL** | Import/edit Web y upload existen; faltan checks Free/1e9/1.9e9 en la operación real. |
| 6 | Trash, overquota, restore y purge | **PARTIAL** | Move/restore/purge Web existen; falta conteo con Trash, prueba de downgrade y política/ejecución segura de purge. |
| 7 | Catálogo comercial y Polar configurado para Web | **PARTIAL** | Ofertas mensuales, resolver y adapter sandbox probados aisladamente; faltan configuración y servicio runtime de venta. |
| 8 | Checkout durable e idempotente | **PARTIAL** | Servicio, migración y tests PostgreSQL existen; no hay ruta de compra de la app conectada. |
| 9 | Webhook firmado, inbox durable y dedupe | **PARTIAL** | Verificación/inbox/migración/tests existen; no hay endpoint/worker Billing montado en runtime. |
| 10 | Lifecycle: pago, cambio, cancelación, grace, refunds | **PARTIAL** | Proyección durable y tests existen; no está conectada a Account/runtime ni cerrada con Polar E2E. |
| 11 | Reconciliación y reparación segura | **PARTIAL** | Servicio, exception queue y tests existen; faltan operación runtime y casos financieros reales completos. |
| 12 | Settings/Account comercial veraz | **PARTIAL** | UI de plan existe, pero dice “Pricing comes later”, simula checkout y anuncia YouTube/límites de sesiones. |
| 13 | Eliminar dev-switch de producto | **NOT STARTED** | `/plans/dev-switch` y su botón siguen presentes; la ruta ya devuelve 404 bajo autoridad PostgreSQL. |
| 14 | Polar Sandbox E2E real completo | **PARTIAL** | Corrida local: compra inicial/webhook/upgrade y Order de renovación `paid`; falta recibo real de webhook de renovación y escenarios independientes de cancelación, refunds, fallos y grace. |
| 15 | E2E final Web y cierre Fase 3 | **NOT STARTED** | Falta recorrido integrado por planes, operaciones, downgrade y cobro con evidencia en SHA exacto. |

`SUPERSEDED` no aplica a una fila de este mapa: `plans.js` y el dev-switch son legado **a sustituir**, pero siguen activos y por eso no se consideran cerrados.

## Evidencia y gates abiertos

En esta base pasaron `npm run test:billing-v1` (103/103), cuatro suites de checkout/webhook/entitlements/reconciliation (27/27) y `npm run preflight:polar-sandbox-e2e`. Son pruebas unitarias/de contrato y sintaxis; **no** se ejecutó PostgreSQL E2E ni Polar real en esta auditoría. Existen migraciones Billing `0006`–`0008` y `0011`–`0013` (última migración general: `0014`) y suites PostgreSQL aisladas; su existencia no certifica la app integrada. El runner histórico Polar se detiene con `BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE`. El estado local ignorado de la corrida diaria `20260912123817_e7cfaa52` (SHA `8943436`, `PARTIAL`) registra un segundo Order pagado, pero `DAILY_REAL_RENEWAL_WEBHOOK_REQUIRED`; no es PASS de renovación ni de Fase 3 E2E.

**STEP 1 (2026-10-08; base `bc99e593f9607c74a919a81c0207894db600b7e8`):** En la autoridad PostgreSQL, el snapshot Auth persiste cuentas/sesiones/proveedores/MFA/vaults sin reconstruir grants. `planState` es sólo una proyección de lectura legacy; un snapshot Auth obsoleto no cambia filas Access, identidad ni fechas. El import de entitlements queda aislado al cutover anterior a `READY`; exportar a JSON excluye grants revocados. Welcome se inserta una vez por usuario con el índice único existente; un fallo al emitirlo durante la verificación permite reintentar. La UI y `/plans/me` aún usan `plans.js`: sustituir esa lectura por el resolver V1 pertenece a STEP 2. La suite amplia Cloud conserva un fallo Direct ajeno a este cambio (`direct-persistent-legacy-lazy.test.cjs` exige un fake `probeSessionMembership`).

**Orden:** STEP 1 ownership/grants → STEP 2 resolver runtime → STEP 3–6 cuotas y enforcement Web/Direct/PROJECT/Trash → STEP 7–11 servicios Billing conectados → STEP 12–13 UI y retiro de dev-switch → STEP 14 Polar real → STEP 15 E2E final. Preparar la renovación natural de STEP 14 temprano cuando sus dependencias estén listas.

**Responsabilidad:** la IA puede implementar y probar STEP 1–13 y 15 con fixtures/entornos aislados y registrar evidencia. STEP 14 requiere acceso a una organización Polar Sandbox, credenciales/relay y completar pagos de prueba y observación de eventos reales; la persona dueña debe proveer o autorizar esos recursos y revisar el resultado. Antes de cobrar a usuarios reales, la persona responsable debe aprobar copy, términos/refunds y configuración comercial. **No hace falta acción del usuario para iniciar STEP 2.**

**Siguiente paso exacto:** STEP 2, hacer del resolver V1 la autoridad runtime única. No iniciado en este cierre.
