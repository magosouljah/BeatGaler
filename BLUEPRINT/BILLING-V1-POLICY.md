# Billing V1 — contrato técnico y comercial

Consolidación **normativa** de reglas, catálogo, checkout, webhook, lifecycle, reconciliación y evidencias Polar. No es un plan de implementación ni autorización de cobros; comprobar código y pruebas en el SHA objetivo. Los nueve expedientes originales siguen consultables en [historial](https://github.com/magosouljah/BeatGaler/tree/748c1de6a309162d2727e4e272098e7d007f3f49/BLUEPRINT).

## Planes y acceso

| Regla | Free | Paid Entry | Highest Paid |
| --- | ---: | ---: | ---: |
| Precio USD/mes | 0 | 6.99 | 11.99 |
| Beats (incluido Trash) | 20 | 100 | Sin límite comercial |
| Nuevo PROJECT ZIP | No | Sí, hasta 1,000,000,000 bytes | Sí, hasta 1,900,000,000 bytes |
| Early Access | No | No | Sí |

- `free < paid_entry < highest_paid`. Acceso efectivo: **máximo** entre Free, cobertura pagada/gracia válida y grants vigentes no revocados, calculado por el servidor con reloj del servidor. No se suman cuotas.
- Tras downgrade, cancelación, impago, refund o expiración **jamás borrar beats, PROJECT ni Trash**. Mantener contenido existente y bloquear nuevas identidades cuando se supera cuota; Free no puede cargar ni reemplazar PROJECT.
- No existen límites **comerciales** V1 de dispositivos/sesiones; controles técnicos y antifraude son independientes. «Sin límite comercial» no significa capacidad técnica ilimitada.
- Política histórica de YouTube: cuotas UTC diarias/mensuales Free 3/31, Entry 10/60, Highest sin límite comercial; Bulk Free none, Entry limited (cantidad pendiente), Highest full. **No se anuncia como función Web disponible si no está verificada.**
- Ofertas servidor: `paid_entry_monthly_v1` (699 minor USD), `highest_paid_monthly_v1` (1199); Free no genera checkout. Venta anual deshabilitada hasta definir precio y condiciones; sin precio supuesto.

## Altas Free y grants anteriores

**En `main` (PR #144/#145):** el registro, OAuth y verificación no emiten siete días nuevos de Paid Entry; cuentas nuevas en **Free**. Grants `source='welcome'` **ya emitidos** conservan fechas originales y expiración en el resolver y esquema: no eliminarlos, reiniciarlos, migrarlos ni revocarlos. El despliegue beta.2 sigue separado de `main`. Promociones futuras de 100% usan Polar cuando sus reglas de checkout/renovación estén validadas; **no** cupones propios ni concesión automática.

## Autoridad financiera y reintentos

- El **servidor** define plan, precio, moneda, capacidades, `salesEnabled` y ofertas. Polar provee Products/Prices; IDs y customer binding no vienen del navegador. Mapear `sandbox` y `production` por separado y comprobar `providerConfigured` antes de ofrecer checkout.
- **Nunca conceder Paid** por redirect, `checkout.created`, `subscription.active`, `current_period_end` o webhook recibido sin procesar. Solo evidencia financiera confirmada de **Order pagado y período válido** puede actualizar `paid_through` en PostgreSQL. Error de proveedor es estado desconocido, no prueba de Free ni Paid.
- Checkout durable e idempotente por usuario/`request_id`; `AMBIGUOUS` tras posible creación externa bloquea otro checkout hasta reconciliar. No crear pagos/suscripciones duplicadas por timeout o refresh.
- Webhooks: validar firma sobre raw bytes **antes** de aceptar, identidad durable proveedor+entorno+`webhook-id`, guardar únicamente datos allowlisted; commit del inbox antes del ACK. Dedupe, leases, recuperación/reintento, serialización por usuario y ownership confiable. Un evento viejo no resucita cobertura refundada.
- Cancelación/downgrade normal mantienen Paid hasta el fin del período pagado. Cambio Paid Entry ↔ Highest se programa para el **siguiente período pagado**; no prorrateo ni upgrade inmediato. Compra fallida no da Paid.
- Renovación fallida: preservar último plan efectivamente pagado **7 días desde primer `past_due_at` confirmado**, sin que retries reinicien la gracia ni otorguen un upgrade pendiente.
- Refund **completo confirmado** del período vigente revoca esa fuente comercial y prepara revocación del proveedor con acción durable; refund parcial no revoca por defecto; refund histórico no revoca otro período, y refund pendiente no se trata como confirmado. Una revocación de acceso jamás elimina archivos. Disputas y acciones administrativas explícitas son auditables.
- Reconciliación descubre cobros/eventos faltantes por cliente verificado y usa las **mismas reglas** de lifecycle sin reescribir grants. Ante incertidumbre conservar estado explícito, sin inventar cobertura.
- Logs y evidencias: no persistir secretos, PAN, métodos de pago, raw payloads, errores crudos del proveedor ni URLs firmadas completas.

## Alcance de evidencia

El contrato Polar histórico fijó SDK `@polar-sh/sdk@1.0.0-alpha.20`, API `2026-04`; comprobar lockfile/runtime actuales antes de cambiarlo. `subscription.cycled` o adelantar `current_billing_period_end` **no prueban** renovación natural: la evidencia de Sandbox diaria exigía dos Orders y Payments reales, webhook verificado y misma suscripción. Parte del E2E histórico quedó **PARTIAL**, no se hereda un PASS productivo.

Probar solamente en entornos aislados y de Sandbox, con SHA y base de datos verificados ([Issue #133](https://github.com/magosouljah/BeatGaler/issues/133)). Referencias de implementación: `cloud-server/billing-*.js`, `cloud-server/migrations/`, `cloud-server/tests/billing-*`; [nueve contratos y runbooks originales](https://github.com/magosouljah/BeatGaler/tree/748c1de6a309162d2727e4e272098e7d007f3f49/BLUEPRINT). Las Actions de Billing se mantienen conectadas a **este** archivo documental.
