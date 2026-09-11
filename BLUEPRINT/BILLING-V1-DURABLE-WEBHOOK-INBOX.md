# Billing V1 — Durable Webhook Inbox

Estado: **Tarea 8 — implementación preparada, sin cutover runtime**.

Este documento describe el contrato durable implementado para recibir y procesar webhooks financieros sin convertir el redirect del checkout en autoridad de acceso.

## Objetivo

Separar dos responsabilidades:

1. **Recepción:** verificar exactamente los bytes firmados y persistir el evento antes de aceptar la entrega.
2. **Procesamiento:** reclamar trabajo durable, resolver bindings confiables, aplicar cambios de negocio de forma idempotente y recuperarse de fallos/reinicios.

La Tarea 8 construye el inbox y el mecanismo de ejecución. Las transiciones comerciales completas de suscripción/pagos/refunds/grace pertenecen a la Tarea 9.

## Identidad durable

La identidad del delivery es:

`provider + provider_environment + webhook-id`

Para Polar/Standard Webhooks, `webhook-id` viene del header firmado. No se usa un `id` inventado por BeatGaler ni se asume que sandbox y production nunca reutilizarán el mismo identificador.

La migración `0012_billing_webhook_durable_inbox.sql` reemplaza la PK global heredada de `0006` por:

`PRIMARY KEY (provider, provider_environment, event_id)`

El mismo delivery ID puede existir una vez en `polar/sandbox` y una vez en `polar/production` sin colisión.

## Recepción

`cloud-server/billing-webhook-durable.js` exige:

- `rawBody` como `Buffer` exacto;
- límite de tamaño antes de persistir;
- verificación oficial mediante el adaptador del proveedor;
- headers `webhook-id`, `webhook-timestamp` y `webhook-signature`;
- forma verificada `type + timestamp + data`;
- `data.id` como subject del evento.

Después de verificar:

1. calcula SHA-256 de los bytes exactos;
2. construye un payload validado mínimo;
3. inserta `RECEIVED` en PostgreSQL;
4. hace `COMMIT`;
5. sólo entonces devuelve recepción exitosa.

La respuesta de recepción mantiene siempre:

`entitlementGranted: false`

El redirect o la mera recepción del webhook no conceden Paid.

## Persistencia mínima

Se persiste únicamente información necesaria para idempotencia, reconciliación y procesamiento:

- provider/environment;
- delivery/event ID;
- event type;
- subject ID;
- timestamp verificado;
- SHA-256 del raw body;
- payload validado mínimo;
- IDs de customer/subscription/checkout cuando existen;
- user resuelto cuando ya puede demostrarse;
- estado, intentos, lease y timestamps;
- códigos de error estables y mensajes redactados.

No se persiste el raw body completo. Campos arbitrarios no allowlisted —por ejemplo secretos, PAN/card data u otros campos inesperados— no pasan al payload durable.

## Estados

Estados permitidos en `billing_webhook_events`:

- `RECEIVED`: verificado y committed; todavía no procesado.
- `PROCESSING`: reclamado por un worker con lease válido.
- `PROCESSED`: handler aplicado y commit local completado.
- `FAILED`: intento fallido; puede tener `next_attempt_at` para retry.
- `IGNORED`: evento verificado pero deliberadamente no soportado/no accionable.

Una fila `PROCESSING` exige `processing_lease_owner` y `processing_lease_until`.

## Deduplicación y replay

Mismo namespace + mismo `webhook-id` + mismos bytes verificados:

- no crea una segunda fila;
- no reinicia el estado;
- devuelve resultado duplicate.

Mismo namespace + mismo `webhook-id` pero contenido firmado distinto:

- falla cerrado con `WEBHOOK_IDENTITY_COLLISION`;
- no reemplaza la fila durable existente.

El mismo `webhook-id` en otro environment se considera otra identidad válida.

## Workers y recuperación

El worker reclama trabajo con:

`FOR UPDATE SKIP LOCKED`

Puede reclamar:

- `RECEIVED`;
- `FAILED` cuyo `next_attempt_at` ya venció;
- `PROCESSING` cuyo lease expiró.

Al reclamar:

- incrementa `attempt_count`;
- entra en `PROCESSING`;
- guarda owner + expiry de lease.

Si un proceso desaparece después de reclamar, otro proceso no toma la fila antes de la expiración; después puede recuperarla y continuar.

## Concurrencia por usuario

El procesamiento usa advisory locks de sesión PostgreSQL con timeout acotado.

Cuando ya existe un binding confiable a usuario, el lock se comparte por ese usuario. Si todavía no puede resolverse, se usa provider/environment/subject como llave conservadora.

Los locks siempre se liberan y la conexión vuelve al pool.

Una nueva recepción no espera a que termine un handler de otro evento: primero entra al inbox; la serialización ocurre en la fase de procesamiento.

## Bindings confiables

El inbox no confía en email ni en IDs elegidos por frontend para adjudicar un hecho financiero.

La resolución usa solamente mappings server-side persistidos:

- `billing_customers.provider_customer_id`;
- `billing_subscription_state.provider_subscription_id`;
- `billing_checkout_requests.provider_checkout_id`.

Si dos identificadores confiables apuntan a usuarios distintos, el procesamiento falla cerrado con `WEBHOOK_BINDING_CONFLICT`.

## Llamadas al proveedor y transacciones

El contrato de handler puede usar dos fases:

- `prepare(context)`: trabajo externo/lookup fuera de una transacción SQL abierta;
- `apply(client, context, prepared)`: mutación local dentro de transacción.

El advisory lock puede mantenerse para serializar el usuario, pero no se mantiene una transacción SQL abierta mientras se espera una llamada de red.

`apply(...)` y el cambio final a `PROCESSED` se confirman en la misma transacción local.

Este contrato queda listo para que Tarea 9 consulte el estado actual de Polar antes de decidir una transición comercial.

## Retry y errores

Los fallos de procesamiento terminan en `FAILED`.

El inbox usa retry exponencial acotado y un máximo de intentos configurable. Se persiste:

- código estable (`last_error_code`);
- mensaje redactado (`last_error_redacted`).

No se persiste el mensaje raw de una excepción del proveedor.

## Compatibilidad con el historial

`0006_billing_webhooks.sql` no fue reescrita.

`0012` migra la tabla existente:

- backfill de `received_at`;
- `IGNORED_OUT_OF_ORDER` legado → `IGNORED`;
- `PROCESSING` legado sin lease → `FAILED` con código de recuperación;
- conserva filas históricas bajo `provider=legacy`, `provider_environment=legacy`;
- `resolved_user_id` usa `ON DELETE SET NULL` para que borrar un usuario no borre el journal financiero.

El procesador síncrono viejo queda como contrato legado/test; no aparece conectado al runtime actual. `0012` tampoco se aplica automáticamente a producción por este trabajo.

## Pruebas

`cloud-server/tests/billing-webhook-durable.integration.cjs` usa PostgreSQL real aislado y cubre:

- firma inválida → no persistence;
- recepción válida → `RECEIVED` committed;
- digest exacto del raw body;
- allowlist de payload durable;
- duplicate exacto;
- colisión por mismo ID/contenido distinto;
- aislamiento del mismo ID entre sandbox y production;
- falta de `webhook-id`;
- evento unsupported → `IGNORED`;
- resolución por binding confiable;
- handler + `PROCESSED` atómicos;
- fallo en `prepare` + retry posterior;
- errores redactados;
- crash/restart vía lease expirado;
- recepción concurrente mientras otro evento está en vuelo;
- conflicto entre customer/subscription bindings.

El gate `.github/workflows/billing-v1-durable-webhook.yml` usa PostgreSQL 18 y además vuelve a ejecutar:

- contratos Billing V1 + Polar;
- contrato webhook legado;
- migraciones `0001`–`0012`;
- checkout persistente de Tarea 7 contra el migration set nuevo.

## Fuera de alcance de Tarea 8

Todavía no se implementa aquí:

- lifecycle completo de payment/subscription/refund;
- grace, access windows, downgrade/upgrade comercial;
- reconciliación periódica completa;
- activar el resolver como authority del runtime;
- conceder Paid desde redirect;
- aplicar `0012` a producción o a una DB histórica real;
- wiring del endpoint Express de producción/cutover;
- cambios a membership, pool de bots, Direct, uploads, playback, downloads, INDEX, Trash o helper Desktop.

Siguiente frontera: **Tarea 9 — lifecycle comercial durable sobre el inbox ya persistente.**
