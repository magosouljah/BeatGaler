> Natural daily Sandbox implementation: see [the daily runbook](BILLING-V1-TASK-11-DAILY-NATURAL.md). The historical accelerated monthly path below remains blocked; implementation support is not renewal PASS.

# Billing V1 — Tarea 11 — Polar Sandbox E2E real

Estado de este documento: **runbook de ejecución y diagnóstico**. Tarea 11 permanece **PARCIAL / BLOQUEADA EN RENOVACIÓN REAL ACELERADA**.

La Tarea 11 sólo puede cerrarse cuando una corrida real termine con `result: "PASS"` en evidencia sanitizada y después vuelvan a pasar los gates Billing. Crear el harness, compilarlo, ejecutar mocks o producir sólo `subscription.cycled` no cierra la tarea.

## Estado verificado el 12 de septiembre de 2026

Corrida real de referencia:

- Run ID: `20260912044806_61ffb048`.
- Polar Sandbox real.
- PostgreSQL aislado real.
- Webhooks reales mediante `polar listen`, aceptados con `202 Accepted`.
- Checkout y pago inicial reales de Sandbox.

La corrida demostró correctamente:

- Free → checkout real → pago real → webhook firmado real → PostgreSQL → Paid Entry.
- Retry/idempotencia del checkout y redirect sin autoridad de acceso.
- Paid Entry → Highest programado con `proration_behavior=next_period` sin conceder Highest antes del siguiente pago.
- La política de BeatGaler conservó Paid Entry cuando Polar cambió la suscripción a Highest pero no existía un segundo Order pagado.

La corrida NO alcanzó PASS completo.

## Blocker confirmado: `current_billing_period_end` NO es un test clock de cobro

El runner histórico adelantaba:

`current_billing_period_end = now + ~90s`

Polar aceptó la modificación y emitió `subscription.cycled`. Sin embargo, no produjo un nuevo `order.created`, `order.paid` ni pago de renovación.

Esto no fue pérdida de webhook, fallo de PostgreSQL ni fallo de firma. El comportamiento del backend de Polar explica la evidencia: al ciclar una suscripción, Polar intenta crear la orden desde billing entries pendientes con un `cutoff` en el cierre del ciclo; si no existen billing entries pendientes, `NoPendingBillingEntries` hace que no se cree una orden. En nuestra corrida, la cobertura financiera inicial ya alcanzaba aproximadamente un mes y mover sólo la fecha de ciclo a ~90 segundos no creó nueva deuda cobrable.

Por tanto:

- `subscription.cycled` = ciclo del proveedor.
- `order.paid` = evidencia financiera.
- un ciclo sin Order pagado NO extiende `paid_through`.
- un ciclo sin Order pagado NO concede Highest.

BeatGaler debe mantener esta separación.

## SDK JS exacto inspeccionado

Paquete fijado por BeatGaler:

- `@polar-sh/sdk@1.0.0-alpha.20`
- entrypoint: `@polar-sh/sdk/2026-04`

Firmas relevantes de ESA versión:

- `subscriptions.get(id)` → una suscripción.
- `subscriptions.list(query)` → `Promise<ListResourceSubscription>` con `.items`.
- `subscriptions.iterList(query)` → `AsyncGenerator<Subscription>` que entrega suscripciones individuales, no páginas.
- `subscriptions.update(id, body)` → actualización de la suscripción.
- `orders.list(query)` → `Promise<ListResourceOrder>` con `.items`.
- `orders.iterList(query)` → `AsyncGenerator<Order>`.

El probe anterior `for await (const page of await subscriptions.list(...))` era incorrecto para este SDK y explica el `TypeError`. El adapter real de BeatGaler ya usa correctamente `list(...).items` mediante su normalizador; no requiere reparación por ese probe.

### `trial_end`

El probe `trial_end: "now"` se hizo sobre una suscripción `active` con `trial_end = null`. En la versión fijada, terminar un trial con `"now"` corresponde a una conversión de trial. Aunque se preparase artificialmente un trial antes, **trial → active + charge** sería una conversión de trial, no una renovación mensual natural. No se acepta como sustituto de Tarea 11.

### pause/resume

El SDK expone `resume: true` como variante de `subscriptions.update(...)`. Reanudar una suscripción pausada abre un período nuevo y cobra inmediatamente. Pero **pause → resume** es una reanudación comercial, no una renovación natural. Tampoco se acepta como sustituto.

### Orders manuales

El SDK también expone creación/finalización de Orders off-session. Un cargo manual puede demostrar que un método guardado se puede cobrar, pero no demuestra que el motor de renovaciones de la suscripción haya generado y cobrado una renovación. Tampoco sustituye el requisito.

## Decisión técnica

No existe actualmente una forma demostrada y honesta, con el Polar Sandbox y SDK fijados por BeatGaler, de adelantar un mes de una suscripción mensual y obtener bajo demanda una **renovación natural + Order de renovación + pago** equivalente a producción.

No se encontró un equivalente documentado al Stripe Test Clock para este flujo.

Por eso el harness oficial ahora se detiene **antes de cualquier efecto externo** con:

`BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE`

El runner histórico `cloud-server/scripts/polar-sandbox-e2e.cjs` se conserva para evidencia y comparación, pero el comando oficial NO lo ejecuta mientras este blocker siga abierto.

No ejecutar directamente el runner histórico para intentar conseguir PASS mediante `current_billing_period_end`.

## Comando oficial mientras exista el blocker

```bash
cd /mnt/e/777/app/beatvault # Entra al checkout habitual de BeatGaler.
git fetch origin billing/v1-policy # Actualiza la referencia remota de la rama Billing.
git switch billing/v1-policy # Cambia a la rama de Billing sin tocar otros archivos locales.
git pull --ff-only origin billing/v1-policy # Exige fast-forward y evita un merge local accidental.
cd cloud-server # Entra al paquete Cloud.
npm ci --ignore-scripts --no-audit --no-fund # Instala exactamente las dependencias fijadas por package-lock.
npm run preflight:polar-sandbox-e2e # Comprueba sintaxis del runner histórico, guard y contrato de bloqueo sin contactar Polar.
export BILLING_E2E_EXPECTED_HEAD="$(git rev-parse HEAD)" # Fija el HEAD exacto que deberá probar una futura corrida real.
npm run e2e:polar-sandbox # Debe detenerse antes de checkout o mutaciones con BILLING_E2E_REAL_RENEWAL_ACCELERATION_UNAVAILABLE mientras siga el blocker.
```

Mientras el guard esté activo NO hace falta iniciar `POLAR LISTEN`, introducir access token, introducir webhook secret ni crear una DB E2E: el comando oficial se detiene antes de usar esos recursos.

## Qué debe ocurrir para retirar el guard

Sólo retirar el guard cuando exista una de estas dos evidencias:

1. Polar exponga/documente un mecanismo Sandbox para provocar una renovación recurrente cobrable equivalente a la renovación natural; o
2. se ejecute/observe una renovación natural real de la suscripción mensual Sandbox.

Antes de aceptar un mecanismo nuevo hay que demostrar que genera, para la MISMA suscripción:

- un nuevo ciclo recurrente;
- un nuevo Order de renovación;
- intento de cobro real Sandbox;
- `order.paid` en éxito o `subscription.past_due`/evidencia equivalente de fallo de cobro;
- período financiero nuevo;
- actualización de `paid_through` sólo después del pago.

No aceptar únicamente cambios de estado de suscripción.

## Alcance que falta para cerrar Tarea 11

Una corrida final PASS todavía debe cubrir realmente:

1. Checkout / pago inicial.
2. Webhook firmado real.
3. PostgreSQL.
4. Paid Entry.
5. Upgrade a Highest.
6. Renovación real y cobrada.
7. Cancelación.
8. `paid_through` / expiración.
9. Full refund.
10. Partial refund.
11. Primer pago fallido.
12. Recuperación del MISMO checkout.
13. `past_due`.
14. grace.
15. recovery.
16. reconciliation.
17. idempotency.
18. replay exacto de webhook / dedupe.

Un FAIL parcial sigue siendo FAIL.

## Seguridad obligatoria

- Usar únicamente organización, token, productos y precios de Polar Sandbox.
- Nunca usar producción.
- Nunca imprimir access tokens, webhook secrets, passwords ni URLs PostgreSQL con credenciales.
- No guardar métodos de pago de prueba en fixtures ni evidencia.
- No guardar URLs completas de checkout/portal ni raw provider payloads en evidencia.
- Los secrets que se pegaron accidentalmente durante pruebas anteriores deben rotarse/revocarse al cerrar la campaña de pruebas reales.

## Cuando Polar permita una renovación acelerada válida

Antes de modificar el guard:

```bash
cd /mnt/e/777/app/beatvault # Entra al repositorio local.
git fetch origin billing/v1-policy # Recupera el HEAD remoto real antes de modificar nada.
git switch billing/v1-policy # Cambia a la rama Billing.
git pull --ff-only origin billing/v1-policy # Sincroniza sólo mediante fast-forward.
git status --short # Revisa trabajo local y conserva cualquier cambio ajeno como BLUEPRINT/BRUNO.md.
git diff --ignore-cr-at-eol # Distingue cambios reales del ruido CRLF/LF.
cd cloud-server # Entra al paquete Cloud.
npm ci --ignore-scripts --no-audit --no-fund # Restaura el SDK exacto fijado por package-lock.
npm run test:billing-v1 # Revalida contrato Billing y el guard antes de cambiarlo.
```

Después de implementar un mecanismo oficialmente válido, volver a ejecutar el E2E completo con `E2E` + `POLAR LISTEN`, obtener evidencia sanitizada `result: "PASS"`, y entonces ejecutar:

```bash
npm run test:billing-v1 # Revalida catálogo, resolver, contratos Polar y contrato de renovación.
npm run test:billing-checkout-pg # Revalida checkout persistente en PostgreSQL aislado de test.
npm run test:billing-webhook-pg # Revalida inbox durable y replay.
npm run test:billing-lifecycle-pg # Revalida lifecycle comercial completo.
npm run test:billing-reconciliation-pg # Revalida reconciliación y logs seguros.
```

Sólo después de una evidencia real `PASS` + gates Billing verdes puede escribirse `TAREA 11 = TERMINADA`.

PR #140 debe permanecer **draft** y NO debe mergearse como parte de Tarea 11.
