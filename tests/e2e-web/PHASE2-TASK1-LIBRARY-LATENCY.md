# Fase 2 — Task 1: atribución de latencia de biblioteca

Este recorrido no repite las cuatro condiciones de Task 0. Conserva cinco
cuentas simultáneas, `vite preview`, Cloud/PostgreSQL/Direct productivos y sólo
mide una apertura fría y un Reload caliente por cuenta.

```powershell
node scripts/run-phase2-task1-attribution.mjs
```

El reporte se guarda en `tmp/phase2-task1/<id>/summary.json`; el detalle con
las diez líneas de tiempo se guarda como `attribution-raw.json`. Cada muestra
incluye timestamp absoluto y relativo para:

```text
inicio/reload → auth/session → Cloud/control → Direct disponible
→ get_index begin/end → procesamiento INDEX Web → biblioteca utilizable
```

También guarda los eventos Direct de `get_index`: `getFullChat`, lookup del
mensaje fijado y descarga del INDEX. Para `getChat` y `getFullChat` conserva
cuatro límites: entrada al método, despacho de `mtcute` `core.call`, resolución
de esa promesa y final del trabajo local. Registra también los estados y errores
que mtcute expone de conexión, y los reintentos/backoffs explícitos de
`get_index`. Las marcas de Cloud usan duraciones del mismo proceso; no se
restan relojes de Windows y Cloud.

## Evidencia recogida el 2026-09-26

`20260926-000233391` terminó `ATTRIBUTION_COMPLETE`: cinco aperturas frías y
cinco Reloads tuvieron todos los marcadores ordenados.

En Reload caliente, el total fue 19.2–26.7 s (media 22.6 s). Sus tramos medios
fueron: auth/session 2.94 s, Cloud/control 5.92 s, control a Direct disponible
3.74 s, espera a `get_index` 1.38 s, `get_index` 7.59 s, procesamiento Web del
INDEX 0.82 ms y publicación de biblioteca 415 ms.

Dentro de `get_index`, `getFullChat` tomó 8.64 s, 1.65 s, 8.12 s, 7.72 s y
2.20 s por cuenta. El lookup del pin y la descarga del documento fueron cada
uno menores que ese tramo. Por tanto el coste no está en JSON, normalización,
React ni en materializar las tarjetas: está en arrancar Direct por Reload y,
después, en la consulta Direct `getFullChat` necesaria para obtener el puntero
del INDEX.

La primera corrida (`20260925-235356230`) fue incompleta: un `session/start`
real produjo timeout de autorización temporal e `invalid nonce hash`, y Account
05 quedó en estado `poor`. No se usa como muestra de rendimiento; confirma que
ese fallo ocurre antes de `get_index`.

## Atribución RPC posterior: `20260926-220259846`

La segunda corrida también terminó `ATTRIBUTION_COMPLETE`, con cinco cuentas
simultáneas y un Reload caliente por cuenta. En esos Reloads `get_index` tuvo
media 5.46 s y p95 6.86 s. `getFullChat` fue `channels.getFullChannel` y
siempre devolvió un `pinnedMsgId`, que es el puntero del documento INDEX usado
por el lookup siguiente.

El tiempo local de `getFullChat` no explica la demora: antes del despacho fue
1–4 ms y tras la respuesta fue 0–1 ms. Su promesa RPC tomó 6.459 s, 1.611 s,
6.537 s, 6.481 s y 1.609 s. `getChat` fue un `channels.getChannels` separado
antes de `get_index`; su RPC fue 99–136 ms y no es el cuello de botella.

En las cuentas 01, 03 y 04, el `channels.getFullChannel` lento observó una
reconexión MTProto a 5.011 s, 5.015 s y 5.017 s después de despachar el RPC. La
reconexión duró 246 ms, 321 ms y 265 ms, y la respuesta llegó cerca de 1.2 s
después de reconectar. No hubo reintentos/backoffs explícitos de `get_index` ni
eventos de error de mtcute. El cliente no publica cada reintento interno de un
RPC, por lo que la evidencia demuestra una espera dentro de la promesa RPC y
una reconexión concurrente, pero no puede atribuir un reenvío interno concreto
sin instrumentar mtcute.

La decisión de Task 2 queda abierta: la evidencia descarta trabajo local,
`getChat` y reintentos del flujo de biblioteca como causa dominante. Antes de
cambiar paralelismo, persistencia de `index_message_id`, caché o formato del
INDEX, hay que decidir si el siguiente experimento debe exponer el intento o
reenvío interno de mtcute alrededor de `channels.getFullChannel`.
