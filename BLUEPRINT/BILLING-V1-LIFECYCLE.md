# BeatGaler Billing V1 — ciclo comercial durable

**Tarea:** 9

**Proveedor V1:** Polar sandbox

**Autoridad operativa local:** PostgreSQL

## Objetivo

Traducir hechos financieros y de suscripción ya verificados por el inbox durable a la proyección comercial que consume el resolver de acceso.

Esta tarea implementa renovación, cancelación, expiración por tiempo, gracia de siete días, cambios de plan al siguiente período y refunds sin tocar archivos, biblioteca, bots, membership, Direct ni sesiones de transporte.

## Regla de autoridad

```text
webhook firmado
→ billing_webhook_events = RECEIVED
→ resolver binding confiable
→ prepare(): releer recurso canónico de Polar
→ apply(): mutar billing PostgreSQL en una transacción
→ billing_webhook_events = PROCESSED en la misma transacción
→ resolveBillingAccess(..., now)
```

La llegada de un webhook no concede acceso por sí sola.

`subscription.active`, un redirect de checkout o un `current_period_end` futuro tampoco conceden Paid por sí solos.

La cobertura comercial normal sólo avanza desde evidencia financiera confirmada: en Polar 2026-04, un `Order` pagado con período de cobertura conocido.

## Suscripciones

Los eventos soportados son:

```text
subscription.created
subscription.updated
subscription.active
subscription.canceled
subscription.uncanceled
subscription.revoked
```

Se usan para sincronizar:

- identidad de customer/subscription;
- producto/precio/oferta actual del proveedor;
- status del proveedor;
- cancelación al final del período;
- período del proveedor;
- `past_due_at`;
- cambio pendiente;
- terminación/revocación.

**No escriben `paid_through`.**

Por tanto un evento de suscripción aislado no puede inventar cobertura pagada.

## Compra y renovación pagadas

Los eventos de Order se releen desde Polar antes de aplicar la mutación local.

Para `order.paid` / un Order canónico pagado:

1. se resuelve Product/Price contra el catálogo server-side;
2. se persiste o actualiza `billing_payments` usando el Order ID como identidad financiera durable;
3. se conserva el período cubierto por el Order;
4. sólo entonces se avanza `paid_through`;
5. se limpia una gracia previa;
6. el plan que acaba de pagarse se vuelve el `plan_id` comercial vigente;
7. si el Order procede del checkout conocido, la solicitud pasa a `COMPLETED`.

Una renovación pagada nunca se infiere únicamente de `status=active`.

## Primera compra fallida

Una suscripción `past_due` sin un período previamente pagado puede quedar proyectada para diagnóstico, pero:

```text
paid_through = null
grace_until = null
```

Por tanto el resolver conserva Free salvo que exista un grant independiente.

## Renovación fallida y gracia

Si existía un tier realmente pagado y la renovación falla:

```text
past_due_at = primer fallo del período
grace_until = past_due_at + 7 días
plan_id = último tier realmente pagado
```

Los retries no reinician los siete días.

Ejemplo:

```text
Paid Entry pagado
→ upgrade a Highest programado
→ renovación de Highest falla
→ gracia conserva Paid Entry
```

Highest sólo entra cuando existe confirmación financiera del nuevo período.

## Cancelación y expiración

La cancelación normal actualiza `cancel_at_period_end`, pero no modifica `paid_through`.

Mientras:

```text
now < paid_through
```

el acceso pagado continúa.

Cuando `now >= paid_through`, el resolver deja de usar esa cobertura sin necesitar un cron que escriba Free en el segundo exacto del vencimiento.

`subscription.uncanceled` puede retirar la intención de cancelación antes del fin del período.

## Cambios de plan

V1 usa cambios entre planes pagados en el siguiente período.

El adaptador Polar lifecycle llama:

```text
subscriptions.update(...)
proration_behavior = next_period
```

La proyección conserva:

```text
next_plan_id
next_interval
next_plan_effective_at
```

sin conceder el nuevo tier antes de que se pague.

Los Orders con `billing_reason=subscription_update`, que representarían una prorrata inmediata, fallan cerrados porque están fuera de la política V1.

## Refunds

### Parcial

Actualiza `billing_payments` a `partially_refunded` y conserva acceso por defecto.

### Completo histórico

Un refund de un período cuyo `period_end` es anterior a la cobertura comercial vigente queda registrado, pero no invalida el período actual.

### Completo del período vigente

En la misma transacción local:

1. el payment queda `refunded` e invalidado;
2. `billing_subscription_state.access_invalidated_at` queda fijado;
3. `invalidation_reason = FULL_REFUND_CURRENT_PERIOD`;
4. se limpia cualquier gracia;
5. se crea una acción durable `REVOKE_SUBSCRIPTION`.

El acceso comercial local se retira inmediatamente por el resolver.

La revocación externa de Polar se procesa después mediante un worker durable con lease/retry. Un timeout del proveedor no revierte la decisión financiera local ni mantiene Paid indefinidamente.

**Ningún refund borra beats, PROJECT, Trash ni otros datos.**

## Protección contra replay y eventos viejos

Cada delivery sigue deduplicado por el inbox durable.

Además, el handler relee el recurso canónico de Polar en `prepare()`. Por ello un delivery viejo de `order.paid` que llega después de que el mismo Order ya está refundado vuelve a observar el estado refundado y no reactiva Paid.

La proyección de un Order sólo avanza la cobertura cuando su período no retrocede respecto a `paid_through` actual.

## Acción externa durable

`0013_billing_lifecycle.sql` agrega `billing_provider_actions` para efectos externos que no deben ejecutarse dentro de la transacción del webhook.

Estados:

```text
PENDING
PROCESSING
SUCCEEDED
FAILED
```

Incluye:

- identidad idempotente;
- lease;
- recovery de lease vencido;
- retry exponencial acotado;
- máximo de intentos;
- error code estable sin persistir el mensaje raw del proveedor.

V1 usa inicialmente esta tabla para `REVOKE_SUBSCRIPTION` después de un refund completo vigente.

## Migración 0013

Además de `billing_provider_actions`, la migración permite que `billing_payments` use como identidad financiera:

```text
provider_payment_id
OR
provider_order_id
```

Esto es necesario porque el recurso financiero canónico usado por Polar en este lifecycle es el Order.

Se mantiene unicidad namespaced por provider + environment.

## Tests

La prueba PostgreSQL de lifecycle cubre:

- compra inicial Paid Entry;
- compra inicial Highest;
- receive durable que todavía no concede Paid;
- replay idempotente;
- cancelación;
- uncancel;
- expiración por `paid_through`;
- upgrade pendiente;
- renovación fallida;
- gracia exacta de siete días;
- retry que no reinicia gracia;
- recuperación mediante pago confirmado;
- downgrade al siguiente período;
- refund parcial;
- refund completo histórico;
- refund completo vigente;
- replay viejo después del refund;
- acción de revoke con fallo y retry;
- primera compra fallida sin gracia;
- crash entre prepare/apply con rollback y retry;
- binding conflict fail-closed.

También existe un contrato unitario del adaptador para fijar `next_period`, Order lookup y revoke.

## Fuera de Tarea 9

Todavía no se hace:

- montar el endpoint durable definitivo en `server.js`;
- convertir el resolver en authority runtime de Auth/Account/Settings;
- enforcement de cuotas reales en uploads/PROJECT/YouTube;
- aplicar `0011`–`0013` sobre la base histórica real;
- reconciliación y logs de Tarea 10;
- E2E completo contra una organización Polar sandbox real de Tarea 11;
- producción.

Esas fronteras son deliberadas: Tarea 9 sólo cambia el dominio y persistencia de billing.
