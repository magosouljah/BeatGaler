# Test G — Plays residuales de 3–5 s

## 1. Resumen ejecutivo

**Decisión: DIAGNOSED.** El total de Task0 empieza **antes** de `await artwork.click()` y termina en el primer evento de estado que confirma `currentTime ≥0.5`. Los Plays lentos tienen tres perfiles observados, no una causa única: demora del comando WebDriver antes del click DOM; demora del reloj/evento de audio en Chrome headless después de que MSE ya entregó un rango reproducible; y, en 2 casos antiguos, preparación de metadata (`getMessages`) de ~2 s antes de descargar el prefijo. La suma de las fronteras medidas explica cada total con un gap de como máximo **2 ms** por redondeo.

En los 180 Plays nuevos con captura diagnóstica, `getMessages` del mensaje 96 no volvió a durar 1 s. En 12 RPC físicos correlacionados, el máximo lógico fue 469 ms. Los dos casos de ~2 s provienen de la captura anterior, que sólo medía la llamada lógica: **su espera anterior o posterior a `WebSocket.send` sigue sin determinarse**. No hay base para cambiar metadata, scheduler, peer, MSE o audio de producción con un fix pequeño y un regression test que proteja una causa probada. El parche FramedWriter de `f067c21` permanece intacto.

## 2. Reproducción y semántica de la medida

Task0 usa la app completa, cinco cuentas y cuatro rondas tras Reload por run. Los cinco Plays de una ronda se lanzan con `Promise.all` en cinco Chrome headless. Cada serie siguiente empezó después de terminar la anterior. Sólo se incluyen runs `VALID`; el piloto con polling invasivo y los intentos bloqueados durante el arranque de Cloud/PostgreSQL se excluyeron. Las series tienen distinta instrumentación y carga del host: **no son un A/B ni un before/after**.

| Serie | Runs / Plays válidos | <1 s | 1–2 s | 2–3 s | 3–4 s | 4–5 s | 5–6 s | ≥6 s | p50 / p90 / p95 / p99 / máximo (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Captura anterior `032036384`, `033202988` | 6 / 120 | 0 | 50 | 47 | 11 | 12 | 0 | 0 | 2104 / 3614 / 4576 / 4980 / 4987 |
| Captura enfocada `053531115`, `054917675` | 6 / 120 | 0 | 21 | 33 | 15 | 21 | 16 | 14 | 3422 / 6198 / 7302 / 10015 / 10192 |
| WARM mensaje 96 `060501314` | 3 / 60 | 0 | 17 | 23 | 12 | 4 | 1 | 3 | 2558 / 4290 / 5072 / 8551 / 8551 |

Hay **109/300 Plays ≥3 s**. La primera serie, menos instrumentada, tenía 23/120 y todos eran de ronda 1. Las dos series posteriores añadieron trazas y tuvieron más latencia de Chrome; no se atribuye esa diferencia a un cambio de playback. Las marcas de `playTrace` en ventana y worker usan `performance.timeOrigin + performance.now()`; la marca pre WebDriver y la de estado de Task0 usan `Date.now()`. La alineación observada entre relojes cerró a ±2 ms en esta captura, pero no es garantía frente a un ajuste del reloj del sistema.

El evento de estado procede de `useAudio`: se publica en `playing` y en `timeupdate`. Por eso el extremo de 0,5 s es el **primer evento que lo confirma**, no necesariamente el instante exacto en que el reloj de audio cruzó 0,5. `AUDIO_EVENT_PLAYING` se registra por separado. En la captura anterior, click DOM→`playing` tuvo p50 **182 ms**, p95 **1775 ms** y sólo **2/120 ≥3 s**; el total original pre WebDriver→evento ≥0,5 tuvo **23/120 ≥3 s**.

## 3. Timelines: rápido frente a lento

[TIMELINES.md](TIMELINES.md) enumera **cada uno de los 109 casos ≥3 s** con los intervalos contiguos, primer progreso y gap. `timelines.json`, ignorado por Git, conserva además las marcas individuales de intent/controller, WARM, preparación, worker, metadata, lane, prefijo, MSE y audio, junto con los RPC físicos correlacionados cuando existen. Los JSON raw locales están en `tmp/phase2-task0/<serie>/run-XX-measurement-raw.json`.

| Caso | Total | WebDriver→click | click→controller | controller→prefijo | prefijo→rango MSE | rango→`playing` | `playing`→≥0,5 | Gap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Rápido: `060501314` run 1, cuenta 03, ronda 4 | 1716 | 172 | 1 | 379 | 108 | 60 | 995 | 1 |
| Metadata lenta: `032036384` run 3, cuenta 03, ronda 1 | 4576 | 434 | 4 | 2796 | 207 | 309 | 826 | 0 |
| Metadata lenta: `033202988` run 2, cuenta 03, ronda 1 | 4720 | 214 | 2 | 2659 | 162 | 625 | 1059 | −1 |
| Audio lento: `054917675` run 3, cuenta 02, ronda 3 | 10192 | 2625 | 1 | 14 | 102 | 37 | 7413 | 0 |

En el caso de audio de 10 192 ms, `PLAY_PREFIX_READY` aparece en +2640, primer rango MSE en +2742 y `AUDIO_EVENT_PLAYING` en +2779. `AUDIO_FIRST_PROGRESS` llega en +9666 con `currentTime=0.053735` y el evento ≥0,5 en +10192. El reloj de audio apenas había avanzado tras **6887 ms** desde `playing`; no hay `getMessages` ni `getFile` en el camino de ese Play. El archivo ya tenía un rango reproducible y `readyState=4` en `playing`. Esto localiza el intervalo en el comportamiento de audio de ese Chrome; los datos no prueban si lo provocaron planificación del host, del proceso de Chrome, salida de audio headless u otra causa interna.

## 4. Accounting y frecuencia por etapa

Los seis tramos contiguos desde la marca pre WebDriver hasta ≥0,5 suman el total observado; `getMessages` y `getFile` son subtramos de controller→prefijo y **no se vuelven a sumar**. De los 300 Plays, el gap máximo absoluto es 2 ms. La clasificación siguiente usa el mayor de los seis intervalos por caso ≥3 s, no asigna causalidad por sí sola.

| Intervalo dominante | Anterior, 23 lentos | Enfocada, 66 lentos | WARM 96, 20 lentos | Total, 109 lentos |
|---|---:|---:|---:|---:|
| WebDriver→click DOM | 9 | 20 | 6 | 35 |
| click DOM→controller | 0 | 0 | 0 | 0 |
| controller→prefijo | 2 | 0 | 0 | 2 |
| prefijo→rango MSE | 0 | 0 | 0 | 0 |
| rango MSE→`playing` | 0 | 0 | 1 | 1 |
| `playing`→evento ≥0,5 | 12 | 46 | 13 | 71 |

La demora de `playing`→≥0,5 se puede dividir de nuevo. En los 66 lentos de la captura enfocada, la mediana `playing`→primer `timeupdate` con progreso es **1865 ms**; primer progreso→evento ≥0,5 es **532 ms**. En los 54 rápidos de esa misma captura son **728 ms** y **533 ms**. El cambio está antes del primer progreso, no en el tramo final ~0,5 s. En varios casos lentos, el primer `timeupdate` informó `currentTime` cercano a cero incluso tras segundos de `playing`; no basta atribuirlo a un evento tardío mientras el reloj avanzaba normalmente.

El caso de 4576 ms ya no deja “~1,9 s adicionales” sin explicar. Dentro de controller→prefijo: controller→inicio lógico de `getMessages` **79 ms**, `getMessages` **2031 ms**, fin de metadata→send físico de `getFile` **12 ms**, `getFile` send→result **667 ms**, result→prefijo **8 ms** (±1 ms por redondeo). Fuera de ese intervalo: **434 + 4 + 207 + 309 + 826 ms**. En el caso de 4720 ms: **43 + 2124 + 6 + 475 + 11 ms** dentro de controller→prefijo; el resto está en la tabla anterior. Session y peer ya figuraban listos al comenzar la metadata en ambos; no hay espera de creación de sesión que explique los ~2 s.

## 5. `getMessages` y `upload.getFile`

Los **dos** `getMessages` lógicos ≥1 s entre los 300 Plays fueron 2031 y 2124 ms, ambos cuenta 03/mensaje 96/ronda 1 en la primera captura, con cache miss y WARM promovido. El tracer físico aún no existía en esos JSON. Por tanto enqueue, flush, send, ACK, `rpc_result`, resend y postprocesado de esos **dos** RPC son **ND**. Sus totales no prueban que Telegram o la red hayan tardado 2 s.

La última serie fijó el foco diagnóstico en el mensaje 96 **desde WARM**, antes del click. En 12/12 rondas de esa cuenta hubo un `channels.getMessages` físico correlacionado: un envío, cero retries registrados, DC 1, `socket-1` del worker de cada Reload y ordinal físico 15. Cola previa **0**, RPC en vuelo previos **0–4** y **2,6–10,1 s** desde el envío físico anterior; esos valores no coincidieron con un `getMessages` de 2 s. Duración lógica **113–469 ms**; llamada→`WebSocket.send` **6–16 ms**; send→`rpc_result` **100–457 ms**; result→retorno **2–14 ms**. El mayor, run 1/ronda 1, tuvo llamada +153, enqueue +158, flush +160, send +161, result +618 y retorno +620 ms relativos al inicio; `rpc_msg_id` y connection UID están en JSON. El estado ACK aparece `null` en esas observaciones; no se registró evidencia suficiente para adjudicar ACK/state request. La espera send→result sólo delimita lo observable por el cliente y no separa red, MTProto o procesamiento remoto.

Ese run 1/ronda 1 duró 5072 ms, pero la metadata quedó lista en +621 **antes** del click DOM en +1496; no explica la demora posterior del Play. El prefijo llegó en +2497, `playing` en +3254 y el evento ≥0,5 en +5072.

Para el mensaje objetivo, los pares físicos correlacionados de `upload.getFile` fueron **56** en la captura anterior, **41** en la enfocada y **35** en WARM 96. Sus p95 send→result fueron respectivamente **938**, **573** y **762 ms**; máximos **1799**, **1378** y **929 ms**. Son pares con envío y respuesta; los hits de caché no se cuentan como RPC de 0 ms. En el caso de 4576 ms, el `getFile` de 667 ms fue real pero menor que `getMessages`. El Test F del writer pasa con el parche activo; no se vieron los tails escalonados antiguos ni se tocó recovery.

## 6. Causa raíz y correlaciones

| Factor observado | Rápidos <3 s (191) | Lentos ≥3 s (109) | Alcance |
|---|---:|---:|---|
| Ronda 1 | 14 | 61 | Fuerte concentración, especialmente en los 120 iniciales; no exclusiva. |
| Cache miss de metadata del objetivo | 35 | 25 | No predice por sí solo un Play lento. |
| `getMessages` objetivo lógico presente | 79 | 35 | Muchas llamadas terminan rápido o durante WARM. |
| `getMessages` objetivo ≥1 s | 0 | 2 | Sólo la captura anterior; etapa física ND. |
| WARM promovido observado | 3 | 3 | Muestra pequeña; no prueba fallo de adoption. |
| Pending join observado | 45 | 10 | No aparece enriquecido en lentos. |
| `CONTROLLER_CONNECT_REUSE` observado | 35 | 25 | No hay patrón de sesión fría. |
| `getFile` físico objetivo correlacionado | 93 | 39 | Presencia del RPC no explica la mayoría. |
| WebDriver→click ≥1 s | 24 | 71 | Parte medible del total antes del intent de app. |
| `playing`→primer progreso ≥1 s | 44 | 81 | Intervalo dominante frecuente después de MSE. |

**Demostrado:** el total de Task0 incluye espera pre click DOM y espera hasta un evento de progreso; 35/109 y 71/109 lentos tienen esos intervalos como máximos. Dos casos antiguos consumieron ~2 s en el `getMessages` lógico, y el resto de ambos totales está contabilizado. El caso de audio citado llegó a `playing` con datos disponibles mucho antes de que su `currentTime` avanzara. **Probable:** los cinco Chrome headless paralelos y la carga variable del host contribuyen al tiempo pre click y al comportamiento del audio; la diferencia entre cohortes es compatible, pero no constituye un experimento causal. **No demostrado:** la causa interna de los 2 s de metadata, la razón interna del retraso del reloj de audio, un error de session/peer, WARM, mtcute o el parche FramedWriter.

## 7. Fix

No se cambió la ruta funcional de reproducción. Sólo se añadió observación diagnóstica opt in en el worker, el probe de Task0 y el analizador. Un cambio como omitir `getMessages`, alterar WARM o modificar el audio sería especulativo: los casos con metadata lenta carecen de desglose físico y la mayoría de los lentos no espera metadata. **No se creó commit de fix.**

## 8. Regression test y validación

El test focalizado de los hooks diagnósticos verifica que `channels.getMessages` atraviesa llamada, cola, flush, send y resultado con el mismo batch y `msg_id`, sin cambiar el RPC. Pasó **2/2**. `npm run test:typecheck` pasó; `npm run build:web` pasó al iniciar la última serie; Task0 terminó **3/3 runs VALID** en esa serie; Test F `npm run test:playback:transport-boundary` pasó **2/2** con writes independientes. Los dos fallos de mocks preexistentes 26/28 no se modificaron ni se usaron como evidencia de Test G.

## 9. Before/after

**No aplica:** no hay fix de playback que comparar. La tabla de reproducción muestra tres condiciones diagnósticas sucesivas con variación considerable; llamarlas “después de un fix” falsearía el resultado. El baseline post FramedWriter de 120 Plays permanece en la primera fila.

## 10. Decisión final

**DIAGNOSED.** Los Plays residuales de Task0 quedan localizados y contabilizados por caso, con dos excepciones raras de metadata cuya etapa física precisa sigue **ND**. La siguiente decisión técnica requiere reproducir uno de esos `getMessages` ≥1 s con el filtro WARM 96 activo, o aislar mediante experimento específico por qué el reloj de audio de Chrome headless se detiene después de `playing`. Ninguna de las dos evidencias existe aún para justificar un fix de producción.
