# Billing V1 — Tarea 7: checkout persistente e idempotente

## Alcance

Esta tarea convierte `billing_checkout_requests` en la autoridad durable de un intento lógico de checkout.

No concede acceso Paid, no procesa webhooks, no implementa lifecycle comercial, no toca Auth como autoridad de acceso, no modifica membership, pool de bots, Direct, uploads, INDEX, Trash ni producción.

## Esquema real usado

La migración `0011_billing_v1_foundation.sql` ya fue validada y no se reescribe.

Sus estados reales son:

```text
CREATING
OPEN
COMPLETED
EXPIRED
FAILED
AMBIGUOUS
```

Para Tarea 7:

- `CREATING`: el intento está persistido y la llamada externa puede estar en curso o haber quedado interrumpida.
- `OPEN`: equivale al resultado recuperable que el plan conceptual llamaba `READY`; tiene checkout ID + URL.
- `AMBIGUOUS`: Polar pudo haber creado el checkout pero BeatGaler no puede demostrar el resultado localmente.
- `COMPLETED`: terminal; el consumo/confirmación definitiva se proyectará por webhooks/lifecycle posteriores.
- `EXPIRED` y `FAILED`: terminales para ese `request_id`.

No se crea un `0012` sólo para renombrar `OPEN` a `READY` o `COMPLETED` a `CONSUMED`.

## Contrato

Entrada server-side:

```text
authenticated user
request_id
offer_id
success URL permitida
return URL permitida
```

Product/Price, plan, moneda y metadata comercial nunca salen del cliente.

El hash SHA-256 del intento lógico cubre:

```text
offer_id
success_url normalizada
return_url normalizada
```

La identidad del usuario no necesita estar en el hash porque forma parte de la PK:

```text
(user_id, request_id)
```

## Flujo

```text
request autenticada
→ resolver oferta local server-side
→ normalizar/allowlist callbacks
→ tomar advisory lock PostgreSQL por usuario
→ comprobar ownership de customer
→ buscar request_id durable
→ retry OPEN idéntico: devolver misma URL
→ CREATING recuperado tras crash: AMBIGUOUS
→ request_id con hash distinto: conflicto
→ comprobar que no exista suscripción viva que deba usar portal
→ comprobar que no exista otro checkout no resuelto
→ INSERT CREATING
→ llamar Polar sandbox
→ persistir checkout ID + URL
→ OPEN
→ devolver resultado durable
```

El advisory lock es de sesión PostgreSQL y se libera siempre. No se mantiene una transacción SQL abierta durante la llamada de red a Polar.

## Timeouts y resultados inciertos

Una transacción local no puede demostrar por sí sola si un POST externo alcanzó a crear un checkout antes de un timeout.

Por eso:

```text
Polar pudo crear checkout
+ BeatGaler no tiene resultado durable demostrable
= AMBIGUOUS
```

Mientras exista `AMBIGUOUS`, no se crea otra sesión de checkout para ese usuario.

Un `CREATING` encontrado después de reinicio también se convierte a `AMBIGUOUS`: volver a ejecutar el POST a ciegas sería inseguro.

Errores que demuestran que todavía no se alcanzó la creación de checkout, como un fallo al consultar/validar el Product mapping antes del create, pueden terminar en `FAILED`.

## Ownership de customer

Si ya existe `billing_customers` para el usuario/proveedor/ambiente, su `external_id` debe coincidir con el `user_id` autenticado.

El checkout Polar siempre recibe:

```text
external_customer_id = authenticated user_id
```

Nunca email ni un ID suministrado por frontend como autoridad de ownership.

Después de crear checkout, la proyección `billing_customers` puede refrescarse de forma best-effort desde Polar. Un fallo de esa proyección no autoriza un segundo checkout.

## Suscriptores existentes

Una cuenta con una suscripción externa todavía viva no abre otra suscripción mediante checkout nuevo.

Debe usar el portal/cambio comercial correspondiente.

Un retry del mismo `request_id` ya `OPEN` sí puede recuperar su resultado durable; esto no constituye un nuevo intento.

## Callbacks

`success_url` y `return_url`:

- deben ser absolutas;
- sólo `http`/`https`;
- sin credenciales embebidas;
- con origen incluido en allowlist server-side;
- no conceden Paid cuando el navegador regresa.

## Persistencia y secretos

Se persiste:

```text
request_id
offer_id
request_hash_sha256
provider/environment
state
provider_checkout_id
checkout_url
expires_at
last_error_code
```

No se persisten secretos de Polar, PAN, CVV, token de tarjeta, cuerpo completo de errores externos ni datos bancarios.

## Evidencia requerida

El gate dedicado debe probar contra PostgreSQL real aislado:

- doble-click concurrente;
- dos tabs con IDs distintos;
- retry idéntico;
- mismo `request_id` con payload alterado;
- timeout ambiguo;
- fallo provider pre-create definitivo;
- recuperación de `OPEN` tras reinicio;
- recuperación de `CREATING` como `AMBIGUOUS`;
- customer ownership incorrecto;
- oferta deshabilitada/desconocida;
- suscriptor existente;
- callback fuera de allowlist.

También vuelve a ejecutar los contratos anteriores de Billing V1 + Polar para detectar regresiones.

## Fuera de Tarea 7

Sigue pendiente:

1. inbox durable de webhooks;
2. lifecycle comercial;
3. reconciliación general;
4. conectar el resolver como autoridad runtime;
5. aplicar migraciones sobre datos históricos reales;
6. E2E completo contra organización Polar sandbox;
7. producción.
