# Test E · frontera de escritura del transporte MTProto

## 1. Executive conclusion

**Desencadenante local confirmado con evidencia fuerte.** El writer compartido puede agrupar dos paquetes cifrados en una llamada WebSocket; el writer con buffer independiente mantiene la misma sesión, socket y concurrencia, y separa las llamadas. La solución candidata es dar un buffer independiente a cada llamada de `FramedWriter.write` y renovar sockets ya afectados durante la transición. La demora observada se mide de `WebSocket.send` a `rpc_result`; el procesamiento remoto interno no es observable.

## 2. Causal chain

`dos flushes MTProto` → `FramedWriter reutiliza un Bytes buffer` → `dos encode concurrentes escriben antes de los continuations de write` → `una WebSocket.send con dos unidades cifradas concatenadas` → `en los tails, respuesta RPC pendiente` → `state recovery antes del rpc_result tardío`. El último tramo describe correlación temporal observada; el servidor no está instrumentado.

Código: `@mtcute/core/network/session-connection.js:1228,1558–1559` → `@mtcute/core/network/persistent-connection.js:92,193–200` → `@fuman/io/codec/writer.js:17–26` → `@mtcute/core/network/transports/obfuscated.js:58–61` → `@mtcute/core/network/transports/intermediate.js:26–28` → `@fuman/net/websocket.js:82–85`. El agrupamiento se produce en la dependencia `@fuman/io`, antes del `socket.send` de Node.

La reproducción local determinista `node tests/playback-e/writer-race.mjs` usa el `FramedWriter` instalado: dos invocaciones concurrentes generan una escritura `[1,2,3,4]` con el writer compartido y dos escrituras `[1,2]`, `[3,4]` con un buffer por llamada. Es una prueba del mecanismo de buffer, no de la respuesta de Telegram.

## 3. Tabla principal

| Caso | writer | mismo socket y concurrente | writes iniciales | n | p50 ms | p95 ms | p99 ms | max ms | ≥6 s |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| E1 · 96+101 baseline | shared | sí | 217 conjunta / 0 separadas | 217 | 6800.4 | 14217.9 | 21744 | 21750.8 | 139 |
| E2/E10 · 96+101 buffer por paquete | fresh | sí | 0 conjunta / 500 separadas | 500 | 95.8 | 179.1 | 201.8 | 456.3 | 0 |

E1: 250 intentos, 33 sin respuesta al msg_id físico inicial, 0 fallos lógicos; E2/E10: 500 intentos, 0 sin par físico inicial, 0 fallos lógicos. Los percentiles principales incluyen únicamente pares físicos completos, misma sesión/socket/DC, con ambos envíos antes de la primera respuesta. En E1, los intentos cuyo msg_id inicial no responde pueden completar por requeue/retry y permanecen visibles en analysis.json.

Si se sigue el mismo RPC lógico a través de retries, E1 tiene 250 respuestas del target; p50 6795 ms, p95 14222.4 ms y 155 ≥6 s desde su primer envío. La tabla principal mantiene el criterio físico más estricto.

Incidentes observados por run: socket nuevo durante el intento 33 → 0; AUTH_KEY_UNREGISTERED 0 → 0; FLOOD_WAIT 0 → 0.

Con 0/500 tails en la variante, el límite superior binomial unilateral aproximado al 95% para la tasa de tails es 0.6% (asumiendo intentos independientes). La prueba no demuestra tasa cero absoluta.

### Controles de orden, timing, cantidad y tamaño

| Caso | n válido | writes conjuntas / separadas | p50 / p95 / max 96 (ms) | ≥6 s | send gap p95 (ms) | bytes iniciales / descargados p50 | state recovery |
|---|---:|---:|---:|---:|---:|---:|---:|
| e3-microtask | 25 | 0 / 25 | 91.9 / 168.7 / 175 | 0 | 1.2 | 376 / 82672 | 0 |
| e3-immediate | 25 | 0 / 25 | 91.2 / 163.3 / 163.7 | 0 | 8.4 | 376 / 82672 | 0 |
| e3-delay1 | 25 | 0 / 25 | 91.5 / 174.4 / 481.9 | 0 | 7.7 | 376 / 82672 | 0 |
| e8-inverse-shared | 22 | 22 / 0 | 6719.9 / 14257.8 / 14334.1 | 17 | 0.1 | 376 / 82672 | 22 |
| e8-inverse-fresh | 25 | 0 / 25 | 345.7 / 444.6 / 464.4 | 0 | 2.2 | 376 / 82672 | 0 |
| e6-one-shared | 25 | 0 / 25 | 1690.8 / 1729.6 / 1977 | 0 | — | 220 / 17136 | 25 |
| e6-one-fresh | 25 | 0 / 25 | 93.6 / 167.9 / 172.4 | 0 | — | 220 / 17136 | 0 |
| e6-three-shared | 16 | 16 / 0 | 9187.4 / 19249 / 19249 | 11 | 0.1 | 532 / 148208 | 16 |
| e6-three-fresh | 20 | 0 / 20 | 90.9 / 129.5 / 172.1 | 0 | 2.6 | 548 / 148208 | 0 |
| e6-four-shared | 16 | 16 / 0 | 6694.1 / 21753.9 / 21753.9 | 9 | 1.7 | 688 / 213744 | 16 |
| e6-four-fresh | 20 | 0 / 20 | 94.7 / 120.8 / 142.3 | 0 | 10.1 | 704 / 213744 | 0 |
| e7-small-small-shared | 22 | 22 / 0 | 6737.8 / 11720.4 / 11770.7 | 14 | 0.1 | 376 / 34272 | 22 |
| e7-small-small-fresh | 25 | 0 / 25 | 96.5 / 168.7 / 217.5 | 0 | 1.6 | 376 / 34272 | 0 |
| e11-stress-shared | 13 | 13 / 0 | 11787.4 / 26760.9 / 26760.9 | 11 | 1.6 | 1156 / 410352 | 13 |
| e11-stress-fresh | 20 | 0 / 20 | 97.1 / 516.1 / 740.1 | 0 | 2.5 | 1204 / 410352 | 0 |
| e2-cross-over-shared | 38 | 38 / 0 | 6701.8 / 14276.2 / 14328.4 | 23 | 0.1 | 376 / 82672 | 38 |
| e2-cross-over-fresh | 39 | 0 / 39 | 6688 / 11778.2 / 14259.2 | 22 | 1.7 | 376 / 82672 | 39 |
| e2-switch-clean-fresh | 15 | 0 / 15 | 101.7 / 187.6 / 187.6 | 0 | 2.9 | 376 / 82672 | 0 |
| e2-switch-shared | 13 | 13 / 0 | 6682.3 / 12536.7 / 12536.7 | 7 | 0.1 | 376 / 82672 | 13 |
| e2-switch-post-fresh | 15 | 0 / 15 | 1680.5 / 1870.4 / 1870.4 | 0 | 0.6 | 376 / 82672 | 15 |
| e2-reset-clean-fresh | 10 | 0 / 10 | 91.5 / 265.7 / 265.7 | 0 | 0.9 | 376 / 82672 | 0 |
| e2-reset-shared | 5 | 5 / 0 | 4185.3 / 9206.6 / 9206.6 | 2 | 0.1 | 376 / 82672 | 5 |
| e2-reset-post-fresh | 5 | 0 / 5 | 328.1 / 9219.2 / 9219.2 | 2 | 0.6 | 376 / 82672 | 2 |
| e2-reset-after-reconnect | 10 | 0 / 10 | 98.3 / 166 / 166 | 0 | 2.1 | 376 / 82672 | 1 |
| e2-reset-immediate-clean-fresh | 10 | 0 / 10 | 99.7 / 140 / 140 | 0 | 1 | 376 / 82672 | 0 |
| e2-reset-immediate-shared | 3 | 3 / 0 | 1679 / 4194.5 / 4194.5 | 0 | 0.1 | 376 / 82672 | 3 |
| e2-reset-immediate-post-fresh | 1 | 0 / 1 | 4210.4 / 4210.4 / 4210.4 | 0 | 0.4 | 376 / 82672 | 1 |
| e2-reset-immediate-after-reconnect | 10 | 0 / 10 | 110.1 / 197.8 / 197.8 | 0 | 0.9 | 376 / 82672 | 1 |

El control de **un solo getFile durante START** no arranca necesariamente limpio: el preparado de descriptores anterior a START hizo 1 writes conjuntas en e6-one-shared y 0 en e6-one-fresh. Así se explica por qué un run con una sola write del target puede seguir lento en una sesión previamente expuesta; no demuestra que una write conjunta ocurriera durante ese run.


El control cruzado alterna writer compartido/fresh dentro del **mismo proceso y auth temporal**. Pares adyacentes válidos: 36; mismo socket 36, misma sesión 36, mismo DC 36.

**Efecto residual:** 22 runs fresh del control cruzado tardaron ≥6 s después de runs shared en el mismo proceso. Por tanto una write conjunta no es necesaria *dentro del mismo run* una vez que la conexión ya estuvo expuesta a una. La serie principal de 500 fresh partió de conexiones sin writes conjuntas durante sus runs.

En ese control, los eventos locales `WebSocket message` recibidos por run tienen mediana 5 (writer compartido) frente a 6 (fresh). El adaptador de `@fuman/net` agrega el contenido de cada mensaje recibido a un buffer de flujo; no conserva límites de frame para el parser MTProto.

La secuencia fresh→shared→fresh usa una sola auth/sesión/socket salvo reconnect observado. Los tres bloques de 15 aparecen separados en la tabla para detectar si una write conjunta deja latencia residual en writes posteriores ya separadas.

| Transición run | writer | socket / sesión iniciales | writes iniciales | 96 send→result (ms) | state req |
|---:|---|---|---:|---:|---:|
| 14 | fresh | 1 / misma | 2 | 101.7 | 0 |
| 15 | fresh | 1 / misma | 2 | 110.9 | 0 |
| 16 | shared | 1 / misma | 1 | 90 | 1 |
| 17 | shared | 1 / misma | 1 | 1749.9 | 2 |
| 18 | shared | 1 / misma | 1 | 4180.7 | 3 |
| 19 | shared | 1 / misma | 1 | 6682.3 | 4 |
| 20 | shared | 1 / misma | 1 | 9203.7 | 5 |
| 29 | shared | 2 / cambió | 1 | 6289.8 | 4 |
| 30 | shared | 3 / cambió | 1 | 1673 | 2 |
| 31 | fresh | 3 / cambió | 2 | 1686.7 | 2 |
| 32 | fresh | 3 / cambió | 2 | 1679.8 | 2 |
| 33 | fresh | 3 / cambió | 2 | 1701 | 2 |
| 34 | fresh | 3 / cambió | 2 | 1677.7 | 2 |
| 45 | fresh | 3 / cambió | 2 | 1678.3 | 2 |

El control de reconnect reemplaza el socket **fuera de START** antes del run 21: 2 → 3, con el mismo hash de sesión ee7a8c84aedd68f5. Los bloques clean, shared, post y after-reconnect aparecen en la tabla. Es una prueba de recuperación secundaria; la solución candidata sigue siendo separar escrituras.

En el control de reconnect **inmediato**: run 14 fresh en socket 1 tardó 4210.4 ms; el reconnect fuera de START cambió socket 1 → 2 con sesión 0d2368acf4817a49; run 15 fresh tardó 197.8 ms. Los 10 runs posteriores aparecen en la tabla.


## 4. Byte/framing evidence

- **e1-baseline/e1-baseline-01/test-d-raw-001:** write 3: 376 B, unidades 220+156 B, SHA-256 0b15b1fe9b077f4017f79232f5e7f4d93cdca6bc41695c5d4b198b6bca93ebad, concatenación exacta=true.
- **e2-e10-fresh/e2-e10-fresh-01/test-d-raw-001:** write 3: 220 B, unidades 220 B, SHA-256 ecdae38b72a8b6c69501146f3ad6748b8663432b24ba46d88225894edc7509a1, concatenación exacta=true; write 4: 156 B, unidades 156 B, SHA-256 7f07f7b2466f78ace47686133b5b5b54a97686c89ac401950d1ace057f539b7c, concatenación exacta=true.
- **Frontera de bytes exacta:** offset 220 de 376 B; 8 bytes cifrados antes `1653c166e51c760e`, después `854e46c877250a5a`. El SHA-256 de la write es `0b15b1fe9b077f4017f79232f5e7f4d93cdca6bc41695c5d4b198b6bca93ebad`; las longitudes cifradas de cada unidad son 220 + 156 B. Comparación de todos los bytes: write = unidad A || unidad B.

Los buffers completos cifrados de muestra quedan localmente en `tmp/playback-e/<serie>/buffers/` (ignorado por Git). El manifiesto del reporte archiva las trazas estructuradas, no claves ni contenido de los archivos. Obfuscated intermediate antepone 4 bytes LE de longitud **antes del cifrado** a cada paquete; por ello el prefijo no puede leerse directamente en el ciphertext. `WebSocket.send` equivale a una llamada de API/mensaje, pero la cantidad de frames WebSocket y paquetes TCP internos no se observa en esta interfaz.

## 5. Timing evidence

**e1-baseline/e1-baseline-01/test-d-raw-003** · 96 send→result 6689.1 ms; writes iniciales 1; estado 4:

- +0 ms START m96
- +1.4 ms D_RAW_CALL_BEGIN m96
- +2 ms D_RAW_CALL_BEGIN m101
- +5.4 ms D_RPC_FLUSH m96
- +7.1 ms D_RPC_FLUSH m101
- +9.7 ms D_WEBSOCKET_SEND write#10
- +99.1 ms D_STATE_INFO_RECEIVED m96
- +1521.6 ms D_WEBSOCKET_SEND write#11
- +1521.7 ms D_STATE_REQ_WEBSOCKET_SEND write#11
- +1608.8 ms D_STATE_INFO_RECEIVED m101
- +4024.5 ms D_WEBSOCKET_SEND write#12
- +4024.5 ms D_STATE_REQ_WEBSOCKET_SEND write#12
- +4117.1 ms D_STATE_INFO_RECEIVED m101
- +6527.1 ms D_WEBSOCKET_SEND write#13
- +6527.2 ms D_STATE_REQ_WEBSOCKET_SEND write#13
- +6699.1 ms D_RPC_RESULT m96
- +9037.9 ms D_WEBSOCKET_SEND write#14
- +9038 ms D_STATE_REQ_WEBSOCKET_SEND write#14
- +9339.8 ms D_RPC_RESULT m101
- +9342.2 ms END

**e2-e10-fresh/e2-e10-fresh-01/test-d-raw-001** · 96 send→result 114.6 ms; writes iniciales 2; estado 0:

- +0 ms START m96
- +1.4 ms D_RAW_CALL_BEGIN m96
- +1.6 ms D_RAW_CALL_BEGIN m101
- +4.4 ms D_RPC_FLUSH m96
- +5.4 ms D_RPC_FLUSH m101
- +7 ms D_WEBSOCKET_SEND write#3
- +8.3 ms D_WEBSOCKET_SEND write#4
- +121.8 ms D_RPC_RESULT m96
- +134.2 ms D_RPC_RESULT m101
- +162.2 ms END

## 6. Stress

Siete solicitudes concurrentes en la misma conexión: baseline 13 runs válidos, p95 26760.9 ms, ≥6 s 11; buffer independiente 20 runs válidos, p95 516.1 ms, ≥6 s 0.

## 7. Overhead

Para el par inicial 96+101, los 376 bytes cifrados son iguales **en cantidad**: una `WebSocket.send(376 B)` en baseline o dos `send(220 B)` y `send(156 B)` en la variante. Se agrega una llamada de API por par, no bytes de framing MTProto. El ciphertext concreto difiere por sesión/contador y no se compara entre runs.

En los pares principales: mediana de escrituras observadas por run (incluido recovery) 5 → 2; bytes salientes medianos 856 → 376; escrituras/s medianas 0.5 → 11.2; throughput de bytes descargados mediano 8851.9 → 462630.1 B/s; CPU del proceso/run p50 48 → 31 ms; delta RSS p50 0.1 → 0.5 MiB; mediana run START→END 9339.5 → 178.6 ms; máximo bufferedAmount antes de send 156 → 220 B. CPU incluye el worker y no aísla sólo el writer; frames TCP no medidos. El número de bytes de framing MTProto no cambia; sí crece el número de llamadas WebSocket.

## 8. Root cause

**Demostrado:** el buffer reutilizado de `FramedWriter` permite juntar ciphertext de múltiples paquetes en una llamada de WebSocket; la separación local conserva conexiones y concurrencia. La concatenación se verifica byte por byte con hashes de cada muestra.

**Altamente probable:** la escritura conjunta deja un estado transitorio de conexión que también afecta a escrituras posteriores ya separadas. El control fresh→shared→fresh muestra esa persistencia; el control de reconnect inmediato conserva la sesión, cambia sólo el socket y recupera tiempos normales. El punto exacto de ese estado (cliente, red o extremo remoto) no es observable aquí. Los escalones de recovery se activan mientras el RPC sigue pendiente y antes de su resultado tardío.

Esta condición es **directa, sin WARM**: el harness llama `downloadChunk` para 96 y 101. El Test D previo observó 0/100 tails al separar sockets; Test E mantiene el mismo socket y demuestra que compartirlo y solapar RPC no bastan en una conexión limpia. Una write conjunta tampoco es necesaria dentro de *cada* run lento después de que el socket ya quedó afectado. La condición de inicio reproducible aquí es exponer ese socket a writes conjuntas; su efecto residual se observa hasta el reconnect.

**Todavía no observable desde cliente:** tiempo interno del servidor, número real de frames WebSocket emitidos ni segmentación TCP. No se atribuye a Telegram una pérdida de paquete o bug concreto.

## 9. Production recommendation

Cambiar `FramedWriter.write` del `@fuman/io` fijado (`node_modules/@fuman/io/codec/writer.js:20–26`) mediante parche de dependencia o upstream: crear un `Bytes` local **por llamada**, codificar ahí y enviar esa copia como una sola unidad. Ése es el diff conceptual mínimo; el campo privado `#buffer` compartido deja de ser usado para escrituras solapadas. Mantener simultáneos los RPC y la misma conexión/socket en operación normal; no cambiar timeouts ni desactivar recovery. La variante impide nuevos agrupamientos en una conexión limpia, pero no sana inmediatamente un socket ya expuesto: en la implementación/rollout hay que validar renovación de esos sockets existentes o dejar que el reconnect normal los sustituya. El control inmediato sugiere que renovar el socket conserva la auth/sesión temporal y limpia el efecto. Antes de publicar, validar el orden del cifrador CTR, reconexiones y la implementación WebSocket de navegador; asignar un buffer por llamada tiene coste de memoria/GC que debe medirse. El harness prototipa el resultado usando un writer fresco por paquete y no modifica el paquete instalado.

## 10. Go / No-Go

**GO** para implementar el aislamiento del buffer de escritura en la dependencia fijada y validarlo en producción. La decisión incluye tratar la transición de sockets ya expuestos: la variante evita nuevos agrupamientos, pero no sana de inmediato un socket afectado. El control de reconnect inmediato lo recuperó sin cambiar de sesión.

## Archivos y reproducción

`node tests/playback-e/run-suite.mjs --phase main`, luego `--phase controls`, después `--phase supplement`, y `node tests/playback-e/rebuild-report.mjs --collect`; ejecutar finalmente `node tests/playback-e/rebuild-report.mjs` verifica todos los hashes y reconstruye el reporte. Requiere Cloud/PostgreSQL y `.env.stage1` como Test D. Las trazas comprimidas y sus hashes están en `traces/manifest.json`.
