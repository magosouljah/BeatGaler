# Billing V1 — Tarea 11 — Polar Sandbox E2E real

Estado de este documento: **runbook de ejecución**, no evidencia de PASS.

La Tarea 11 sólo se puede cerrar cuando una corrida real termine con `result: "PASS"` en la evidencia sanitizada y después vuelvan a pasar los gates Billing. Crear el harness, compilarlo o ejecutar mocks no cierra la tarea.

## Alcance

Proveedor: **Polar**  
Ambiente: **Sandbox**  
Persistencia: **PostgreSQL aislado creado por la corrida**  
Rama: `billing/v1-policy`  
Runner: `cloud-server/scripts/polar-sandbox-e2e.cjs`

El runner valida:

- Free inicial.
- Checkout persistente real.
- Retry con el mismo `request_id`.
- Segundo intento cercano bloqueado mientras existe checkout abierto.
- Redirect sin autoridad de acceso.
- Pago Sandbox real.
- Webhook real entregado por Polar mediante `polar listen`.
- Firma sobre raw body.
- Persistencia durable antes de procesamiento.
- Replay exacto del webhook sin duplicar efectos.
- PostgreSQL → resolver → Paid.
- `paid_through` respaldado por Order pagado.
- Paid Entry → Highest programado con `proration_behavior=next_period`.
- Highest sólo después de un nuevo pago real.
- Cancelación real al final del período sin downgrade inmediato.
- Límite exacto de `paid_through` con reloj local inyectado sobre la cobertura financiera real.
- Refund completo real y revoke durable del proveedor.
- Refund parcial real sin pérdida automática de acceso.
- Primera compra fallida que permanece Free.
- Recuperación de la misma compra sin segunda suscripción.
- Renovación fallida real → `subscription.past_due` → siete días de gracia BeatGaler.
- Recuperación de renovación después de pago exitoso.
- Reconciliación con objetos reales, reparación inequívoca, rechazo de discrepancia ambigua y outage que no se interpreta como Free.

No valida uploads, cuotas de biblioteca, PROJECT, YouTube, bots, Direct, playback, downloads, INDEX, Trash ni Desktop helper.

## Seguridad obligatoria

- Usar únicamente organización, token, productos y precios de **Polar Sandbox**.
- No usar secrets live.
- No apuntar `BILLING_E2E_TEST_ADMIN_URL` a la base histórica de BeatGaler.
- El URL de admin debe terminar en `/postgres`; el runner crea una DB `beatgaler_billing_e2e_*` y la elimina al final.
- No pegar tokens ni webhook secrets en issues, PRs, artifacts o logs.
- No guardar métodos de pago de prueba en fixtures ni evidencia.
- La evidencia no guarda URLs de checkout/portal ni raw provider payloads.

## Antes de ejecutar

El token Sandbox necesita acceso a los objetos comerciales usados por Billing. La organización debe tener configurados los dos mappings de V1:

- `paid_entry_monthly_v1` → USD 6.99 mensual.
- `highest_paid_monthly_v1` → USD 11.99 mensual.

Polar documenta Sandbox aislado y el relay oficial de webhooks locales con Polar CLI:

- https://polar.sh/docs/integrate/webhooks/locally
- https://polar.sh/docs/integrate/webhooks/delivery

Para métodos de pago, usar únicamente los métodos de prueba oficiales documentados por Polar/Stripe. Durante la corrida el runner pedirá tres comportamientos, no números concretos:

1. pago exitoso;
2. rechazo genérico durante checkout;
3. método que se puede guardar pero falla en el próximo cobro off-session.

## Preparación automatizable

Ejecutar desde WSL/Linux para quedar junto al PostgreSQL de pruebas.

```bash
cd /mnt/e/777/app/beatvault # Entra al checkout habitual de BeatGaler.
git fetch origin billing/v1-policy # Actualiza únicamente la referencia remota de la rama Billing.
git switch billing/v1-policy # Cambia a la rama vigente de Billing; no continúes si Git reporta conflicto con trabajo local.
git pull --ff-only origin billing/v1-policy # Exige fast-forward y evita crear un merge local accidental.
cd cloud-server # Entra al paquete Cloud que contiene Billing y el runner E2E.
npm ci --ignore-scripts --no-audit --no-fund # Instala exactamente las dependencias fijadas por package-lock.
npm run preflight:polar-sandbox-e2e # Comprueba la sintaxis del runner sin contactar Polar ni crear cobros.
export BILLING_E2E_EXPECTED_HEAD="$(git rev-parse HEAD)" # Fija el SHA exacto que la evidencia debe probar.
export BILLING_E2E_TEST_ADMIN_URL='postgresql://TEST_CREATEDB_USER:LOCAL_TEST_PASSWORD@127.0.0.1:5432/postgres' # Usa un usuario local con CREATEDB y sólo el DB admin postgres.
export POLAR_SANDBOX_E2E_EMAIL='billing-task11-sandbox@example.test' # Define un correo exclusivo de prueba; puede sustituirse por otro correo Sandbox controlado.
export POLAR_SANDBOX_E2E_WEBHOOK_TRANSPORT='polar-cli-listen' # Obliga al runner a usar el transporte real de webhooks de Polar CLI.
```

Configurar después los IDs no secretos del catálogo Sandbox:

```bash
export POLAR_SANDBOX_ORGANIZATION_ID='REPLACE_SANDBOX_ORG_ID' # Identifica exclusivamente la organización Polar Sandbox.
export POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRODUCT_ID='REPLACE_SANDBOX_PRODUCT_ID' # Mapea Paid Entry al producto Sandbox real.
export POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRICE_ID='REPLACE_SANDBOX_PRICE_ID' # Mapea Paid Entry al precio Sandbox real.
export POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID='REPLACE_SANDBOX_PRODUCT_ID' # Mapea Highest al producto Sandbox real.
export POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRICE_ID='REPLACE_SANDBOX_PRICE_ID' # Mapea Highest al precio Sandbox real.
```

Introducir el access token sin escribirlo en el historial del shell:

```bash
read -rsp 'POLAR_SANDBOX_ACCESS_TOKEN: ' POLAR_SANDBOX_ACCESS_TOKEN && export POLAR_SANDBOX_ACCESS_TOKEN && printf '\n' # Lee el token Sandbox en modo silencioso y sólo lo exporta al proceso actual.
```

## Webhook real — terminal separado

Instalar Polar CLI si todavía no existe y autenticarlo siguiendo la documentación oficial. Después:

```bash
polar login # Inicia la sesión interactiva de Polar CLI; selecciona la cuenta/organización Sandbox correcta.
polar listen http://127.0.0.1:4011/webhooks/polar # Abre el relay oficial que entrega webhooks reales de Polar al runner local.
```

El comando `polar listen` muestra un secret temporal de firma. En la terminal donde se ejecutará BeatGaler, introducirlo sin guardarlo en archivo ni historial:

```bash
read -rsp 'POLAR_SANDBOX_WEBHOOK_SECRET from polar listen: ' POLAR_SANDBOX_WEBHOOK_SECRET && export POLAR_SANDBOX_WEBHOOK_SECRET && printf '\n' # Mantiene el secret temporal sólo en el entorno del proceso.
```

No usar simultáneamente el secret de un endpoint distinto: el webhook debe verificarse con el secret emitido por el relay activo.

## Ejecutar la corrida

```bash
npm run e2e:polar-sandbox # Crea PostgreSQL aislado, aplica migraciones, levanta el receptor local y conduce el journey real completo.
```

### Interactivo inevitable

El runner imprimirá únicamente URLs temporales necesarias para completar acciones en navegador. No las guarda en la evidencia.

Cuando lo pida:

1. Completar el checkout principal con el método Sandbox de **pago exitoso**.
2. Completar el checkout del escenario de **refund completo** con el método Sandbox de pago exitoso.
3. En el checkout de recuperación, usar primero el método Sandbox de **rechazo genérico**; confirmar el fallo y luego recuperar **la misma sesión** con el método exitoso.
4. En Customer Portal, cambiar el método guardado al test method que **se adjunta correctamente pero falla en el próximo cobro off-session**; el runner adelanta oficialmente `current_billing_period_end` para provocar la renovación.
5. Tras `subscription.past_due`, volver al Customer Portal y restaurar el método Sandbox exitoso para que Polar reintente y recupere el cobro.

Refund completo/parcial, cambio programado, cancelación, reconciliación y cleanup no necesitan intervención humana: los ejecuta el harness mediante Polar Sandbox y PostgreSQL.

## Expiración: qué es Polar real y qué es reloj local

Polar no ofrece un equivalente documentado al test clock de Stripe para saltar arbitrariamente un período ya pagado. Por eso la corrida separa dos pruebas:

- **Real Polar Sandbox:** cancelación `cancel_at_period_end=true` y evento real de cancelación conservando el estado comercial vigente.
- **Comprobación temporal local complementaria:** resolver evaluado a `paid_through - 1 ms` y `paid_through + 1 ms` usando el `paid_through` que provino del Order real.

No se etiqueta esa segunda parte como tiempo acelerado por Polar.

## Evidencia

Por defecto se escribe fuera del worktree, dentro del área privada de Git:

`<git-dir>/beatgaler-billing-e2e/<run-id>.json`

Contiene, de forma sanitizada:

- commit SHA probado;
- usuario BeatGaler de prueba;
- request IDs;
- IDs externos de checkout/customer/subscription/order/payment/event;
- estado PostgreSQL antes/después;
- resultado del resolver;
- pruebas de persist-before-process y replay idempotente;
- timestamps y PASS/FAIL por escenario.

No contiene access token, webhook secret, raw payload, números de método de pago ni URL completa de checkout/portal.

Si la corrida falla, la evidencia termina con `result: "FAIL"` y un código de error sanitizado. Un FAIL no debe reinterpretarse como PASS parcial del escenario que falló.

## Cleanup

La DB aislada se elimina automáticamente en `finally`. Sólo para diagnóstico explícito puede conservarse temporalmente:

```bash
export BILLING_E2E_KEEP_DATABASE=1 # Conserva exclusivamente la DB efímera de esta corrida para inspección; nunca usar contra una DB histórica.
```

Después del diagnóstico, eliminar manualmente esa DB efímera antes de otra corrida.

## Cierre

Después de obtener una evidencia real con `result: "PASS"`, volver a ejecutar todos los gates Billing del HEAD exacto:

```bash
npm run test:billing-v1 # Revalida catálogo, resolver y contratos Polar.
npm run test:billing-checkout-pg # Revalida checkout persistente en PostgreSQL aislado de test.
npm run test:billing-webhook-pg # Revalida inbox durable y replay.
npm run test:billing-lifecycle-pg # Revalida lifecycle comercial completo.
npm run test:billing-reconciliation-pg # Revalida reconciliación y logs seguros.
```

Los tests PostgreSQL anteriores requieren sus variables `*_TEST_ADMIN_URL` habituales apuntando a una instancia de pruebas, nunca a la base histórica/productiva.

**Sólo entonces** puede escribirse `TAREA 11 = TERMINADA`. Hasta que exista esa evidencia, el estado correcto es `TAREA 11 = PARCIAL`.
