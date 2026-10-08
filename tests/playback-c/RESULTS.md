# Test C · resultado e interpretación

Ejecución: 6 oct 2026. Cuenta `03`, mensaje `96`, `Stage1 Playback v2 03.mp3` (17 136 bytes). Test A con sesión y peer preparados, WARM iniciado 10 ms antes de `START`, sin navegador ni audio. La métrica principal es la llamada local a `WebSocket.send` del `upload.getFile` 96 → primer frame de respuesta correlacionado con su `msg_id`. Los hits de caché se excluyen. No se cambió código de producción; sus hashes SHA-256 coinciden en todas las series.

Entre `normal-01` y `normal-02` se amplió el probe para registrar uid/DC y consultas de reenvío; antes de `suppress-01` se añadió el registro de consultas de estado del competidor. Esas revisiones agregan metadatos y no modifican la ruta de ejecución normal. Los hashes del probe por serie constan en `tmp/playback-c/final/summary.json`.

## Respuesta principal

**¿Vienen los +2.5 s de mtcute? Parcialmente.** mtcute agenda la primera consulta de estado a los 1500 ms y, si no contesta, la repite tras un timeout de 2500 ms. En 200 RPC físicos normales hubo 71 respuestas sin consulta (mediana 171 ms), y los otros 129 cayeron casi exactamente en los escalones de ~1.7, 4.2, 6.7, 9.2 y 11.7 s. Adelantar la primera consulta a 100 ms en el worker aislado desplazó los escalones a ~0.2, 2.8, 5.3 y 7.8 s. El resultado llegó típicamente ~172 ms después de la última consulta en normal y ~163 ms en la variante temprana. La cadencia de mtcute determina la posición de los escalones observados.

**mtcute no origina todo el retraso.** En la variante que impide *solo* las consultas de estado del RPC 96, nueve respuestas llegaron en ~165–191 ms, una llegó por sí sola a los 10 874.6 ms, y una seguía sin respuesta cuando el harness la censuró a los 14 991.8 ms. La demora puede existir sin `msgs_state_req`; algunas solicitudes también necesitan recuperación o no responden dentro del límite observado. El límite de 15 s termina únicamente la observación del harness.

**¿Ayuda o perjudica el recovery?** Puede ayudar: en dos runs de la variante temprana, un estado `0x02` produjo reenvío del RPC y respuesta posterior; sin consultas, otro RPC siguió pendiente más de 15 s. El intervalo y los timeouts de `msgs_state_req` espacian las oportunidades de consulta y dan forma a la escalera, pero no hay evidencia de que reenvíen el archivo en los 200 normales ni de que empeoren las respuestas espontáneas. Un RPC sin consultas respondió después de 10.87 s, así que la escalera tampoco mide directamente cuánto tardó Telegram en procesar el archivo. El experimento no justifica reducir el timeout como solución.

**La condición reproducible más fuerte es el WARM concurrente.** Con WARM `[96,101]`, 65/200 RPC normales tardaron ≥6 s (p95 9212.5 ms, máximo 11 740.6 ms). Con WARM solo `[96]`, 0/50 tardaron ≥6 s (p95 268.7 ms, máximo 952.7 ms) y no llegó a enviarse ninguna consulta de estado del 96. Al volver a `[96,101]`, 6/20 tardaron ≥6 s (p95 9205.2 ms). En los 200 normales se invocó `WebSocket.send` para ambos archivos en la misma `SessionConnection` (uid 0); la respuesta del 96 llegó siempre antes que la del 101. Por tanto, el resultado del 96 no espera la finalización del lote 101, pero la coexistencia de ambos RPC sobre esa conexión se asocia estrechamente con el problema. Las series son secuenciales, así que queda un posible factor temporal no controlado por aleatorización; el control de retorno reduce esa explicación.

| Condición | Intentos con RPC físico respondido | p50 send→respuesta | p95 | máximo | ≥6 s | Censurados |
|---|---:|---:|---:|---:|---:|---:|
| Normal `[96,101]` | 200 | 1706.6 ms | 9212.5 ms | 11 740.6 ms | 65 | 0 |
| State temprano `[96,101]` | 50 | 277.9 ms | 7815.7 ms | 7888.6 ms | 6 | 0 |
| State suprimido `[96,101]` | 10 de 11 | 171.3 ms | 10 874.6 ms | 10 874.6 ms | 1 | 1 a 14 991.8 ms |
| Solo `[96]` | 50 | 171.1 ms | 268.7 ms | 952.7 ms | 0 | 0 |
| Retorno `[96,101]` | 20 | 1675.1 ms | 9205.2 ms | 9261.6 ms | 6 | 0 |

El percentil de `suppress` incluye el RPC 96 que sí respondió a los 10.87 s, aunque el harness marcó luego el *batch* WARM como `HarnessTimeout` por el competidor. El otro RPC fue censurado y no se trata como respuesta de duración cero.

## Qué dicen realmente los estados

En los 200 RPC normales no llegó ningún `msgs_state_info` **antes** del `rpc_result`, no hubo requeue del `upload.getFile`, y su `msg_id` nunca cambió. Hubo 293 estados `0x6c` correlacionados con 125 runs, todos posteriores a su respuesta. `0x6c` significa: recibido (`4`), reconocido (`+8`), procesamiento iniciado o completado (`+32`) y respuesta generada (`+64`). Como llegaron después del resultado, no prueban cuándo el servidor recibió el RPC ni si su respuesta previa se perdió.

En los 50 RPC de la variante temprana llegaron cinco estados antes del resultado: dos `0x02` (“no recibido”) y tres `0x2c` (“recibido y reconocido; procesamiento iniciado o completado; respuesta todavía no marcada como generada”). Los dos `0x02` hicieron que mtcute reencolara el RPC con un `msg_id` nuevo. Eso demuestra que el recovery puede rescatar una petición declarada no recibida **en el experimento**; forzar la consulta tan temprano puede introducir una carrera de entrega, por lo que esos dos estados no se extrapolan a los tails normales. Los `0x2c` no provocaron requeue: mtcute continuó esperando. Decodificación conforme a la [especificación oficial MTProto](https://core.telegram.org/mtproto/service_messages_about_messages).

En un tail normal de ~6.7 s, el primer `msgs_state_req` sale cerca de +1.5 s, vence cerca de +4.0 s, el segundo vence cerca de +6.5 s y el tercero precede al `rpc_result` por ~170 ms. El timeout reencola **la consulta de estado**, no el `upload.getFile` original. Los ACK previos del servidor aparecen en 5/71 respuestas rápidas y en 0/129 lentas. La ausencia de ACK observable no demuestra que el DC no recibiera el RPC.

## Timelines causales representativos

- `early-1-warm-adopt-027`: `upload.getFile` enviado a −5.6 ms de `START`; consulta a +497.8 ms; estado `0x02` a +577.9 ms; requeue a +578.6 ms; nuevo `msg_id` a +580.9 ms; segunda consulta a +692.4 ms; `rpc_result` a +745.5 ms. Tiempo send→respuesta: 748.9 ms.
- `early-1-warm-adopt-041`: consulta a +126.7 ms; `0x2c` a +206.0 ms; sin requeue; `rpc_result` a +308.4 ms. Tiempo send→respuesta: 181.1 ms.
- `suppress-1-warm-adopt-007`: WebSocket `send` a +7.9 ms; ningún state check ni `rpc_result` del 96 hasta la censura ~15 s después.
- `suppress-1-warm-adopt-014`: WebSocket `send` a −4.3 ms; ningún state check del 96; `rpc_result` a +10 872.1 ms (10 874.6 ms desde `send`). El timeout posterior fue del lote competidor, no del RPC 96.

## Causa probable y límite de atribución

La condición inmediata para entrar en `getStateSchedule` es simple: mtcute aún tiene el `upload.getFile` pendiente 1500 ms después de enviarlo por la API WebSocket. El control solo/pareado/de retorno apunta a la presencia del segundo `upload.getFile` de WARM 101 en la misma conexión como disparador reproducible de ese silencio. No hay una espera larga antes de `send` ni una dependencia de PCM, MSE o audio. Tampoco hay reenvío normal del RPC que explique los 2.5 s adicionales: esos intervalos son esperas por `msgs_state_info` que vencen y hacen salir otra consulta.

No está demostrado **por qué** el par de RPC produce respuestas tardías: `WebSocket.send` confirma encolado local, no entrega al DC. Faltan marcas del lado servidor o del paquete en la red para distinguir pérdida/no entrega, procesamiento MTProto/Telegram, respuesta retenida, WebSocket/transporte o un efecto de concurrencia/configuración de mtcute. El hecho de que un RPC en `suppress` respondiera solo tras 10.87 s impide atribuir toda la espera al state recovery. Tampoco hay evidencia de DC incorrecto, recreación de sesión, un retry de `upload.getFile` en los normales o bloqueo esperando el resultado del 101.

Para evitar la condición desde la raíz, la siguiente comparación dirigida debería mantener los mismos dos archivos y bytes pero variar **solo** si sus `upload.getFile` se solapan en la misma conexión, en conexiones distintas o de forma secuencial; registrar salida real de paquetes, `bufferedAmount`, frames entrantes y estado de sesión/DC. Si el solapamiento en una conexión resulta causal, la política de WARM/focus o la asignación de conexiones podrá revisarse con esa evidencia. No se implementó ningún cambio de scheduling, timeout ni playback.

## Reproducción y evidencia

Comandos y requisitos en [README.md](README.md). Trazas crudas con `ts_ms`, `run_id`, `intent_id`, `msg_id` y eventos del worker: `tmp/playback-c/{normal-01,normal-02,normal-03,normal-04,early-01,suppress-01,solo-01,normal-return-01}/trace.jsonl`. Las mismas ocho trazas permanecen localmente como JSONL comprimido en `traces/`, ignorado por Git, con hashes del contenido crudo en `traces/manifest.json`. Resumen correlacionado de todos los RPC principales: `tmp/playback-c/final/physical-rpcs.json`; métricas agregadas: `tmp/playback-c/final/summary.json`; controles: `tmp/playback-c/solo-report` y `tmp/playback-c/return-report`. El script puede regenerar los datos sin cambiar producción.

`node --check` pasó para harness, probe y reporte; `node --test tests/playback-direct/report.test.mjs tests/playback-b/report.test.mjs` pasó (8/8). La serie `suppress` terminó `PARTIAL` por los timeouts de medición esperados; las demás series terminaron `COMPLETE`.

---

## Detalle generado: distribución, tabla de cada RPC físico y timelines normales

# Test C · mtcute state recovery para upload.getFile

RPC físicos normales válidos del mensaje 96: 200. Duración WebSocket send→primer frame correlacionado p50 1706.6 ms, p95 9212.5 ms, máximo 11740.6 ms.

| Duración | RPC | ACK antes de result | Con state_req | # state_req | Info antes de result | Timeout antes de result | Con resend | Nuevo msg_id | Estados brutos |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| <500 ms | 71 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| 500–2500 ms | 32 | 0 | 32 | 32 | 0 | 0 | 0 | 0 | 108 |
| 2.5–5 s | 32 | 0 | 32 | 64 | 0 | 32 | 0 | 0 | 108 |
| 5–7.5 s | 34 | 0 | 34 | 102 | 0 | 34 | 0 | 0 | 108 |
| 7.5–10 s | 27 | 0 | 27 | 106 | 0 | 27 | 0 | 0 | 108 |
| >10 s | 4 | 0 | 4 | 20 | 0 | 4 | 0 | 0 | 108 |

Tiempos p50 relativos a `START` de cada grupo; el conteo de timeouts excluye los posteriores a `rpc_result`:

| Duración | state_req #1 | state_req #2 | # timeouts previos | rpc_result |
|---|---:|---:|---:|---:|
| <500 ms | — | — | 0 | 173 |
| 500–2500 ms | 1503.9 | — | 0 | 1675.6 |
| 2.5–5 s | 1503.2 | 4012.5 | 32 | 4181.9 |
| 5–7.5 s | 1510.6 | 4017.2 | 68 | 6699.5 |
| 7.5–10 s | 1501 | 4009 | 79 | 9198.7 |
| >10 s | 1497.4 | 4005.2 | 16 | 11733.5 |

## Estados MTProto

- 108 (0x6c): recibido; flag +8 reconocido=true, +32 procesando/completo=true, +64 respuesta generada=true, +128 certeza adicional=false.

La semántica del byte sigue la [especificación oficial MTProto](https://core.telegram.org/mtproto/service_messages_about_messages). Un estado recibido después de `rpc_result` describe lo que el servidor sabe en ese momento posterior; no prueba cuándo recibió el RPC ni cuándo generó la respuesta.

La columna ACK cuenta solo `mt_msgs_ack` del servidor antes de `rpc_result`; `_onMessageAcked` también se invoca al procesar una respuesta y no se confunde con un ACK previo. Las marcas de `state_req` son envíos reales de WebSocket correlacionados al `msg_id` del RPC 96. Los timeouts o `state_info` posteriores a `rpc_result` se conservan en los timelines, sin atribuirles causalidad retrospectiva.

## RPC físicos por run

| Run | Harness | getFile ms | ACK | state_req #1 | estado #1 | timeout #1 | state_req #2 | estado #2 | resend | rpc_result | msg_ids |
|---|---|---:|---|---:|---|---:|---:|---|---|---:|---|
| normal-1-warm-adopt-001 | OK | 167 | no | — | — | — | — | — | no | 316.4 | 7693674321270748008 |
| normal-1-warm-adopt-003 | OK | 172.7 | no | — | — | — | — | — | no | 170.2 | 7693674326249252232 |
| normal-1-warm-adopt-005 | OK | 170.7 | no | — | — | — | — | — | no | 170.3 | 7693674338922480184 |
| normal-1-warm-adopt-007 | OK | 1664.9 | no | 1514.3 | 108 (0x6c) @5967.2 | 4019.1 | — | — | no | 1678.6 | 7693674363453005240 |
| normal-1-warm-adopt-009 | OK | 4196.1 | no | 1508.1 | 108 (0x6c) @8494.3 | 4018.6 | 4019.8 | 108 (0x6c) @11001.4 | no | 4191.9 | 7693674403007476640 |
| normal-1-warm-adopt-011 | OK | 6687.1 | no | 1500.7 | 108 (0x6c) @10888 | 4008.5 | 4009.2 | 108 (0x6c) @13399.6 | no | 6689.3 | 7693674466310081680 |
| normal-1-warm-adopt-013 | OK | 6700.5 | no | 1492.7 | — | 4001 | 4001.8 | — | no | 6691.8 | 7693674548688218628 |
| normal-1-warm-adopt-015 | OK | 165.5 | no | — | — | — | — | — | no | 150.8 | 7693674592180745004 |
| normal-1-warm-adopt-017 | OK | 186.6 | no | — | — | — | — | — | no | 169.4 | 7693674604774555252 |
| normal-1-warm-adopt-019 | OK | 1660.6 | no | 1490.4 | 108 (0x6c) @5858.3 | 4001.7 | — | — | no | 1659.4 | 7693674626985432584 |
| normal-1-warm-adopt-021 | OK | 4169.2 | no | 1489.7 | 108 (0x6c) @8370.2 | 3993.4 | 3994.2 | 108 (0x6c) @10882.5 | no | 4169.3 | 7693674668551031224 |
| normal-1-warm-adopt-023 | OK | 6691.2 | no | 1498.1 | 108 (0x6c) @11077.4 | 4005.5 | 4006.5 | 108 (0x6c) @13554.1 | no | 6690.4 | 7693674729443941248 |
| normal-1-warm-adopt-025 | OK | 9179.9 | no | 1507.8 | 108 (0x6c) @11094.9 | 4011.5 | 4012.1 | 108 (0x6c) @11107.8 | no | 9189.1 | 7693674814544139844 |
| normal-1-warm-adopt-027 | OK | 166.9 | 78.9 | — | — | — | — | — | no | 163.8 | 7693674896958026056 |
| normal-1-warm-adopt-029 | OK | 87.6 | no | — | — | — | — | — | no | 83.2 | 7693674901789814600 |
| normal-1-warm-adopt-031 | OK | 191.5 | no | — | — | — | — | — | no | 187.4 | 7693674914146222136 |
| normal-1-warm-adopt-033 | OK | 1696.1 | no | 1501.7 | 108 (0x6c) @5939.6 | 4009.9 | — | — | no | 1687.9 | 7693674939022468184 |
| normal-1-warm-adopt-035 | OK | 4171.3 | no | 1545.4 | 108 (0x6c) @8430.1 | 4049.7 | 4051.7 | 108 (0x6c) @10938.2 | no | 4213.5 | 7693674978532789100 |
| normal-1-warm-adopt-037 | OK | 6692.7 | no | 1522 | 108 (0x6c) @10908.6 | 4024.1 | 4024.8 | 108 (0x6c) @13402.2 | no | 6699.5 | 7693675041797898596 |
| normal-1-warm-adopt-039 | OK | 9204.8 | no | 1500.4 | 108 (0x6c) @11807 | 4004.6 | 4005.2 | 108 (0x6c) @14318.1 | no | 9208.4 | 7693675124224110072 |
| normal-1-warm-adopt-041 | OK | 162.6 | no | — | — | — | — | — | no | 174.2 | 7693675213999072868 |
| normal-1-warm-adopt-043 | OK | 171.8 | no | — | — | — | — | — | no | 170.5 | 7693675226493719636 |
| normal-1-warm-adopt-045 | OK | 1671.7 | no | 1501.6 | 108 (0x6c) @5896.3 | 4012.6 | — | — | no | 1674.4 | 7693675248667023488 |
| normal-1-warm-adopt-047 | OK | 4174.7 | no | 1497.6 | 108 (0x6c) @8455.1 | 4000.5 | 4001.3 | 108 (0x6c) @10950.9 | no | 4171.9 | 7693675288221581688 |
| normal-1-warm-adopt-049 | OK | 6678.2 | no | 1531.1 | 108 (0x6c) @10944 | 4029.4 | 4030.9 | 108 (0x6c) @13443.5 | no | 6700.3 | 7693675351889141660 |
| normal-1-warm-adopt-051 | OK | 9199.8 | no | 1498.6 | 108 (0x6c) @11119.5 | 4000.4 | 4001.4 | 108 (0x6c) @13397.9 | no | 9198.7 | 7693675434359393368 |
| normal-1-warm-adopt-053 | OK | 168.8 | no | — | — | — | — | — | no | 179.8 | 7693675524100758908 |
| normal-1-warm-adopt-055 | OK | 175.7 | no | — | — | — | — | — | no | 174 | 7693675536767711852 |
| normal-1-warm-adopt-057 | OK | 1695 | no | 1537.8 | 108 (0x6c) @6089.4 | 4052.7 | — | — | no | 1718.4 | 7693675559068652776 |
| normal-1-warm-adopt-059 | OK | 4188.5 | no | 1515.7 | 108 (0x6c) @8401.4 | 4017.1 | 4017.8 | 108 (0x6c) @10919.3 | no | 4194.1 | 7693675601244641684 |
| normal-1-warm-adopt-061 | OK | 6725.2 | no | 1547.2 | 108 (0x6c) @10935.2 | 4047.4 | 4048.7 | 108 (0x6c) @13446.4 | no | 6730.1 | 7693675662158557876 |
| normal-1-warm-adopt-063 | OK | 9212.5 | no | 1516.6 | 108 (0x6c) @10909.6 | 4030.7 | 4031.7 | 108 (0x6c) @13413.8 | no | 9218.2 | 7693675746822695392 |
| normal-1-warm-adopt-065 | OK | 170.3 | no | — | — | — | — | — | no | 157.3 | 7693675833130868852 |
| normal-1-warm-adopt-067 | OK | 166.5 | no | — | — | — | — | — | no | 189.8 | 7693675846055429212 |
| normal-1-warm-adopt-069 | OK | 1775.7 | no | 1497.4 | 108 (0x6c) @5978.7 | 4011.6 | — | — | no | 1778.6 | 7693675870600761580 |
| normal-1-warm-adopt-071 | OK | 4177.5 | no | 1522.5 | 108 (0x6c) @8396.5 | 4025.9 | 4026.6 | 108 (0x6c) @10904.7 | no | 4189.5 | 7693675910461385532 |
| normal-1-warm-adopt-073 | OK | 6810.7 | no | 1538.1 | 108 (0x6c) @11107.2 | 4046.8 | 4047.4 | 108 (0x6c) @13606 | no | 6807.4 | 7693675973642096424 |
| normal-1-warm-adopt-075 | OK | 9187.9 | no | 1503.9 | 108 (0x6c) @10885.8 | 4007.7 | 4008.5 | 108 (0x6c) @13401.7 | no | 9191 | 7693676056471051708 |
| normal-1-warm-adopt-077 | OK | 168.5 | no | — | — | — | — | — | no | 166.3 | 7693676142926284960 |
| normal-1-warm-adopt-079 | OK | 168.7 | no | — | — | — | — | — | no | 167.7 | 7693676155427287280 |
| normal-1-warm-adopt-081 | OK | 1678.6 | no | 1510.4 | 108 (0x6c) @5933.6 | 4022.3 | — | — | no | 1675.6 | 7693676179886611872 |
| normal-1-warm-adopt-083 | OK | 4170.3 | no | 1508 | 108 (0x6c) @8410.6 | 4011.5 | 4012.8 | 108 (0x6c) @10921.1 | no | 4178.5 | 7693676219424220460 |
| normal-1-warm-adopt-085 | OK | 6711.4 | no | 1524.9 | 108 (0x6c) @10958.3 | 4027.7 | 4028.3 | 108 (0x6c) @13470.7 | no | 6726.1 | 7693676280386241204 |
| normal-1-warm-adopt-087 | OK | 9198.3 | no | 1491.2 | 108 (0x6c) @11114.8 | 3999.5 | 4000.5 | 108 (0x6c) @11124.8 | no | 9185.9 | 7693676365243239292 |
| normal-1-warm-adopt-089 | OK | 173.5 | 98.1 | — | — | — | — | — | no | 186.8 | 7693676447724395436 |
| normal-1-warm-adopt-091 | OK | 217.4 | no | — | — | — | — | — | no | 255.6 | 7693676455324407672 |
| normal-1-warm-adopt-093 | OK | 169.7 | no | — | — | — | — | — | no | 175.1 | 7693676469115389112 |
| normal-1-warm-adopt-095 | OK | 1660.3 | no | 1496.2 | 108 (0x6c) @5848.8 | 4009.6 | — | — | no | 1662.9 | 7693676493511321840 |
| normal-1-warm-adopt-097 | OK | 4170.9 | no | 1509.8 | 108 (0x6c) @8374.6 | 4011.1 | 4012.5 | 108 (0x6c) @10886.4 | no | 4180.6 | 7693676532979581320 |
| normal-1-warm-adopt-099 | OK | 7160 | no | 1504.5 | 108 (0x6c) @11471.8 | 4013.2 | 4013.9 | 108 (0x6c) @13886.3 | no | 7159.6 | 7693676593826677724 |
| normal-2-warm-adopt-001 | OK | 164.2 | no | — | — | — | — | — | no | 280.1 | 7693676871476917188 |
| normal-2-warm-adopt-003 | OK | 159.2 | no | — | — | — | — | — | no | 190.6 | 7693676876623388140 |
| normal-2-warm-adopt-005 | OK | 172.6 | no | — | — | — | — | — | no | 193.5 | 7693676890103840528 |
| normal-2-warm-adopt-007 | OK | 1671.2 | no | 1506.3 | 108 (0x6c) @5989 | 4005.5 | — | — | no | 1670.4 | 7693676914558776892 |
| normal-2-warm-adopt-009 | OK | 4172.1 | no | 1570.9 | 108 (0x6c) @8455.7 | 4070.5 | 4071.4 | 108 (0x6c) @10966.6 | no | 4232.5 | 7693676954597549236 |
| normal-2-warm-adopt-011 | OK | 6696.2 | no | 1505.8 | 108 (0x6c) @11145.4 | 4018.8 | 4019.5 | 108 (0x6c) @13648.3 | no | 6697.1 | 7693677017776499748 |
| normal-2-warm-adopt-013 | OK | 9186.3 | no | 1513.2 | 108 (0x6c) @13404 | 4027.5 | 4032.2 | 108 (0x6c) @15906.5 | no | 9202.2 | 7693677099835981472 |
| normal-2-warm-adopt-015 | OK | 11740.6 | no | 1497.4 | 108 (0x6c) @15954.3 | 4004.5 | 4005.2 | 108 (0x6c) @18531.4 | no | 11740.6 | 7693677203693221092 |
| normal-2-warm-adopt-017 | OK | 11717.3 | no | 1521 | — | 4022.4 | 4023.6 | — | no | 11733.5 | 7693677331491269836 |
| normal-2-warm-adopt-019 | OK | 164.8 | no | — | — | — | — | — | no | 159.5 | 7693677405030127792 |
| normal-2-warm-adopt-021 | OK | 173.5 | no | — | — | — | — | — | no | 181.8 | 7693677417688303564 |
| normal-2-warm-adopt-023 | OK | 1685.6 | no | 1518.5 | 108 (0x6c) @5893.6 | 4027.9 | — | — | no | 1692.7 | 7693677439951631824 |
| normal-2-warm-adopt-025 | OK | 4164.6 | no | 1485.5 | 108 (0x6c) @8348.7 | 3986.9 | 3987.8 | 108 (0x6c) @10855.2 | no | 4150.5 | 7693677481561630344 |
| normal-2-warm-adopt-027 | OK | 6696 | no | 1529.4 | 108 (0x6c) @10935.4 | 4033.8 | 4034.4 | 108 (0x6c) @13447.1 | no | 6721.5 | 7693677542385093780 |
| normal-2-warm-adopt-029 | OK | 9182.2 | no | 1512.1 | 108 (0x6c) @10931.2 | 4012.5 | 4013.6 | 108 (0x6c) @13438.4 | no | 9189.3 | 7693677624832681212 |
| normal-2-warm-adopt-031 | OK | 159.3 | no | — | — | — | — | — | no | 158 | 7693677705988183048 |
| normal-2-warm-adopt-033 | OK | 103 | no | — | — | — | — | — | no | 93.1 | 7693677718491542968 |
| normal-2-warm-adopt-035 | OK | 1656.5 | no | 1498.5 | 108 (0x6c) @5851.1 | 4002.9 | — | — | no | 1659.1 | 7693677740543071756 |
| normal-2-warm-adopt-037 | OK | 4175.5 | no | 1495.2 | 108 (0x6c) @8363.9 | 4002.1 | 4002.8 | 108 (0x6c) @10874.2 | no | 4169.3 | 7693677782301451840 |
| normal-2-warm-adopt-039 | OK | 6700.9 | no | 1505.1 | 108 (0x6c) @11018.1 | 4012.4 | 4013.2 | 108 (0x6c) @13530 | no | 6695.9 | 7693677843525638788 |
| normal-2-warm-adopt-041 | OK | 9227.2 | no | 1498.1 | 108 (0x6c) @10920.6 | 4008.4 | 4009 | 108 (0x6c) @13435 | no | 9222.3 | 7693677928458461272 |
| normal-2-warm-adopt-043 | OK | 163.2 | no | — | — | — | — | — | no | 171.1 | 7693678010046001460 |
| normal-2-warm-adopt-045 | OK | 189.8 | no | — | — | — | — | — | no | 184.3 | 7693678022580739148 |
| normal-2-warm-adopt-047 | OK | 1673.2 | no | 1514.4 | 108 (0x6c) @5898.8 | 4023 | — | — | no | 1679.7 | 7693678044808455308 |
| normal-2-warm-adopt-049 | OK | 4186.3 | no | 1487.6 | 108 (0x6c) @8376.5 | 4000.3 | 4001 | 108 (0x6c) @10883.2 | no | 4176.2 | 7693678084146776776 |
| normal-2-warm-adopt-051 | OK | 6690.8 | no | 1558.7 | 108 (0x6c) @10994.8 | 4068.5 | 4069.1 | 108 (0x6c) @13499 | no | 6748.3 | 7693678147466016720 |
| normal-2-warm-adopt-053 | OK | 9198.6 | no | 1496.9 | 108 (0x6c) @10892.3 | 4009.8 | 4010.4 | 108 (0x6c) @13404.8 | no | 9199.6 | 7693678229927934580 |
| normal-2-warm-adopt-055 | OK | 176.1 | no | — | — | — | — | — | no | 179.9 | 7693678311358412196 |
| normal-2-warm-adopt-057 | OK | 97.5 | no | — | — | — | — | — | no | 97.8 | 7693678323935213884 |
| normal-2-warm-adopt-059 | OK | 1683.7 | no | 1499.2 | 108 (0x6c) @5880 | 4010.2 | — | — | no | 1671 | 7693678345942675576 |
| normal-2-warm-adopt-061 | OK | 4188.6 | no | 1503.5 | 108 (0x6c) @8419.7 | 4015.2 | 4015.9 | 108 (0x6c) @10932 | no | 4184.7 | 7693678387512192812 |
| normal-2-warm-adopt-063 | OK | 6709.1 | no | 1519.1 | 108 (0x6c) @10921.6 | 4030.9 | 4031.5 | 108 (0x6c) @13437.2 | no | 6718 | 7693678448472296176 |
| normal-2-warm-adopt-065 | OK | 9229.2 | no | 1500.4 | 108 (0x6c) @10935.9 | 4000.3 | 4002.5 | 108 (0x6c) @13442.7 | no | 9230.4 | 7693678530871634248 |
| normal-2-warm-adopt-067 | OK | 199.1 | no | — | — | — | — | — | no | 195.6 | 7693678612631142528 |
| normal-2-warm-adopt-069 | OK | 178.6 | no | — | — | — | — | — | no | 163.1 | 7693678625543305348 |
| normal-2-warm-adopt-071 | OK | 1669.3 | no | 1504.7 | 108 (0x6c) @5879 | 4013.8 | — | — | no | 1667.9 | 7693678650128290812 |
| normal-2-warm-adopt-073 | OK | 4181.4 | no | 1518.4 | 108 (0x6c) @8398.1 | 4020.6 | 4021.1 | 108 (0x6c) @10915.4 | no | 4191.1 | 7693678689607060676 |
| normal-2-warm-adopt-075 | OK | 6687 | no | 1490.7 | 108 (0x6c) @10886.4 | 3997.1 | 3997.8 | 108 (0x6c) @13397.6 | no | 6679.5 | 7693678752630539140 |
| normal-2-warm-adopt-077 | OK | 9259.5 | no | 1493.3 | 108 (0x6c) @10959.3 | 3997 | 3997.7 | 108 (0x6c) @13470.3 | no | 9248.8 | 7693678835027831204 |
| normal-2-warm-adopt-079 | OK | 167.9 | no | — | — | — | — | — | no | 167.2 | 7693678916407430764 |
| normal-2-warm-adopt-081 | OK | 166.5 | no | — | — | — | — | — | no | 170.1 | 7693678928994711784 |
| normal-2-warm-adopt-083 | OK | 1686.6 | no | 1518.8 | 108 (0x6c) @5913.6 | 4024 | — | — | no | 1692.9 | 7693678951277208132 |
| normal-2-warm-adopt-085 | OK | 4192.3 | no | 1512.6 | 108 (0x6c) @8411.1 | 4015 | 4017.1 | 108 (0x6c) @10927.5 | no | 4204.4 | 7693678993639548016 |
| normal-2-warm-adopt-087 | OK | 6683.4 | no | 1555.2 | 108 (0x6c) @10926.2 | 4058.6 | 4059.2 | 108 (0x6c) @13430.7 | no | 6729.6 | 7693679054834252832 |
| normal-2-warm-adopt-089 | OK | 9312.2 | no | 1505.2 | 108 (0x6c) @11065.7 | 4017.6 | 4018.7 | 108 (0x6c) @13599.5 | no | 9309 | 7693679139502713128 |
| normal-2-warm-adopt-091 | OK | 163 | no | — | — | — | — | — | no | 159.7 | 7693679218382960160 |
| normal-2-warm-adopt-093 | OK | 175.7 | no | — | — | — | — | — | no | 192.6 | 7693679233675473660 |
| normal-2-warm-adopt-095 | OK | 1664.4 | no | 1501.3 | 108 (0x6c) @5894.1 | 4013.1 | — | — | no | 1666.7 | 7693679256037365916 |
| normal-2-warm-adopt-097 | OK | 4199.7 | no | 1503.2 | 108 (0x6c) @8381.5 | 4016.2 | 4018.6 | 108 (0x6c) @10884.4 | no | 4192.3 | 7693679298345057160 |
| normal-2-warm-adopt-099 | OK | 6693.2 | no | 1520.1 | 108 (0x6c) @10944.2 | 4022.9 | 4023.9 | 108 (0x6c) @13461 | no | 6707.5 | 7693679359259071988 |
| normal-3-warm-adopt-001 | OK | 167.5 | no | — | — | — | — | — | no | 282.2 | 7693712318139754548 |
| normal-3-warm-adopt-003 | OK | 173 | no | — | — | — | — | — | no | 200.4 | 7693712323458250904 |
| normal-3-warm-adopt-005 | OK | 224.3 | no | — | — | — | — | — | no | 219.8 | 7693712336217202640 |
| normal-3-warm-adopt-007 | OK | 1654.1 | no | 1498 | 108 (0x6c) @5941.8 | 4009.8 | — | — | no | 1667.2 | 7693712360915458276 |
| normal-3-warm-adopt-009 | OK | 4178.3 | no | 1509.5 | 108 (0x6c) @8391 | 4013.8 | 4017.3 | 108 (0x6c) @10910.2 | no | 4192.9 | 7693712400459485520 |
| normal-3-warm-adopt-011 | OK | 6687.7 | no | 1510.8 | 108 (0x6c) @10886.2 | 4012.4 | 4013.1 | 108 (0x6c) @13413.2 | no | 6684.4 | 7693712461274772660 |
| normal-3-warm-adopt-013 | OK | 6689.1 | no | 1510.6 | — | 4019 | 4019.9 | — | no | 6698.1 | 7693712545833938392 |
| normal-3-warm-adopt-015 | OK | 89.8 | no | — | — | — | — | — | no | 96.8 | 7693712592558522624 |
| normal-3-warm-adopt-017 | OK | 196.4 | no | — | — | — | — | — | no | 185.3 | 7693712602700298764 |
| normal-3-warm-adopt-019 | OK | 1664.9 | no | 1493.2 | 108 (0x6c) @5864.8 | 3994.9 | — | — | no | 1663.1 | 7693712627090289448 |
| normal-3-warm-adopt-021 | OK | 4187 | no | 1501.5 | 108 (0x6c) @8396.5 | 4011 | 4011.7 | 108 (0x6c) @10939.4 | no | 4177.2 | 7693712666424503904 |
| normal-3-warm-adopt-023 | OK | 6706.3 | no | 1483.5 | 108 (0x6c) @10962.5 | 3990.5 | 3991.5 | 108 (0x6c) @13466.6 | no | 6692.3 | 7693712730037151704 |
| normal-3-warm-adopt-025 | OK | 9185.2 | no | 1506.7 | 108 (0x6c) @11383.5 | 4008.3 | 4009.2 | 108 (0x6c) @13410.4 | no | 9200 | 7693712812671245000 |
| normal-3-warm-adopt-027 | OK | 168.7 | no | — | — | — | — | — | no | 170.4 | 7693712902375016268 |
| normal-3-warm-adopt-029 | OK | 127.1 | no | — | — | — | — | — | no | 137.7 | 7693712914899168692 |
| normal-3-warm-adopt-031 | OK | 1686.2 | no | 1503.9 | 108 (0x6c) @5882.7 | 4011.1 | — | — | no | 1688.4 | 7693712936981888804 |
| normal-3-warm-adopt-033 | OK | 4168.1 | no | 1493.3 | 108 (0x6c) @8586.4 | 3993 | 3993.8 | 108 (0x6c) @11093.8 | no | 4161.8 | 7693712979646628984 |
| normal-3-warm-adopt-035 | OK | 6699.5 | no | 1516.6 | 108 (0x6c) @11007.7 | 4015.8 | 4016.5 | 108 (0x6c) @13524.4 | no | 6707.8 | 7693713040973639044 |
| normal-3-warm-adopt-037 | OK | 9260.6 | no | 1545.1 | 108 (0x6c) @11007.9 | 4083.1 | 4084 | 108 (0x6c) @13515.7 | no | 9298.1 | 7693713126025471016 |
| normal-3-warm-adopt-039 | OK | 165.5 | no | — | — | — | — | — | no | 162.9 | 7693713212495280444 |
| normal-3-warm-adopt-041 | OK | 94.4 | no | — | — | — | — | — | no | 95.7 | 7693713224971263980 |
| normal-3-warm-adopt-043 | OK | 1708.5 | no | 1539.6 | 108 (0x6c) @5926.8 | 4052.8 | — | — | no | 1720 | 7693713249696506532 |
| normal-3-warm-adopt-045 | OK | 4171.5 | no | 1526.3 | 108 (0x6c) @8413.7 | 4032 | 4033.2 | 108 (0x6c) @10944.4 | no | 4194.5 | 7693713289194518992 |
| normal-3-warm-adopt-047 | OK | 6695.1 | no | 1497.5 | 108 (0x6c) @10878.2 | 3999.4 | 4001.3 | 108 (0x6c) @13382.5 | no | 6696.3 | 7693713350345164432 |
| normal-3-warm-adopt-049 | OK | 9182.3 | no | 1511.8 | 108 (0x6c) @11478.8 | 4012.5 | 4013.3 | 108 (0x6c) @13402.1 | no | 9191.5 | 7693713434942529892 |
| normal-3-warm-adopt-051 | OK | 413.5 | 83.9 | — | — | — | — | — | no | 415.6 | 7693713525294022032 |
| normal-3-warm-adopt-053 | OK | 423.5 | no | — | — | — | — | — | no | 427.5 | 7693713538692914620 |
| normal-3-warm-adopt-055 | OK | 1664.5 | no | 1494 | 108 (0x6c) @5837.9 | 3994.7 | — | — | no | 1655.6 | 7693713563850303468 |
| normal-3-warm-adopt-057 | OK | 4224.6 | no | 1511.4 | 108 (0x6c) @8429.7 | 4016.1 | 4018 | 108 (0x6c) @10937.6 | no | 4236.2 | 7693713603414960268 |
| normal-3-warm-adopt-059 | OK | 6672.5 | no | 1518.4 | 108 (0x6c) @10909.4 | 4019.2 | 4020 | 108 (0x6c) @13405.8 | no | 6692.1 | 7693713666925034632 |
| normal-3-warm-adopt-061 | OK | 9331.2 | no | 1498.1 | 108 (0x6c) @11051.4 | 4000.7 | 4001.4 | 108 (0x6c) @13601.1 | no | 9323.6 | 7693713749645327648 |
| normal-3-warm-adopt-063 | OK | 174.1 | no | — | — | — | — | — | no | 186.7 | 7693713835129476680 |
| normal-3-warm-adopt-065 | OK | 173.6 | no | — | — | — | — | — | no | 173 | 7693713847756191084 |
| normal-3-warm-adopt-067 | OK | 1669 | no | 1524.7 | 108 (0x6c) @5945.8 | 4028.2 | — | — | no | 1695.9 | 7693713870048950012 |
| normal-3-warm-adopt-069 | OK | 4176.2 | no | 1500.8 | 108 (0x6c) @8390.2 | 4011.7 | 4012.3 | 108 (0x6c) @10896.3 | no | 4179.5 | 7693713911814016156 |
| normal-3-warm-adopt-071 | OK | 6681.5 | no | 1499.2 | 108 (0x6c) @10877.6 | 4005 | 4005.6 | 108 (0x6c) @13393.3 | no | 6680.9 | 7693713972740407976 |
| normal-3-warm-adopt-073 | OK | 9209.6 | no | 1505.3 | 108 (0x6c) @11505.7 | 4016.2 | 4017 | 108 (0x6c) @13400 | no | 9203.9 | 7693714057335387980 |
| normal-3-warm-adopt-075 | OK | 252.6 | 91.4 | — | — | — | — | — | no | 256.9 | 7693714147319771640 |
| normal-3-warm-adopt-077 | OK | 165.1 | no | — | — | — | — | — | no | 163.4 | 7693714160175260552 |
| normal-3-warm-adopt-079 | OK | 1706.6 | no | 1504.3 | 108 (0x6c) @5908.3 | 4007.7 | — | — | no | 1704.7 | 7693714182296015744 |
| normal-3-warm-adopt-081 | OK | 4174.1 | no | 1499 | 108 (0x6c) @8381.3 | 3998.7 | 3999.3 | 108 (0x6c) @10896 | no | 4169.1 | 7693714221766585116 |
| normal-3-warm-adopt-083 | OK | 6682.2 | no | 1524.5 | 108 (0x6c) @10911.7 | 4028.9 | 4029.9 | 108 (0x6c) @13413.7 | no | 6702.5 | 7693714284857459740 |
| normal-3-warm-adopt-085 | OK | 9212.1 | no | 1498.4 | 108 (0x6c) @11597.4 | 4008.1 | 4008.9 | 108 (0x6c) @13400.3 | no | 9209.8 | 7693714367235664632 |
| normal-3-warm-adopt-087 | OK | 160.4 | no | — | — | — | — | — | no | 160.3 | 7693714457669129516 |
| normal-3-warm-adopt-089 | OK | 175.2 | no | — | — | — | — | — | no | 173 | 7693714470379716988 |
| normal-3-warm-adopt-091 | OK | 1694.6 | no | 1510.8 | 108 (0x6c) @5881.1 | 4020.6 | — | — | no | 1694 | 7693714492737584008 |
| normal-3-warm-adopt-093 | OK | 4169.9 | no | 1497 | 108 (0x6c) @8376.4 | 4010.5 | 4011.1 | 108 (0x6c) @10887.1 | no | 4175.5 | 7693714534374100764 |
| normal-3-warm-adopt-095 | OK | 6667.9 | no | 1501.9 | 108 (0x6c) @10880.7 | 4001.7 | 4002.4 | 108 (0x6c) @13388.5 | no | 6670.2 | 7693714595210724192 |
| normal-3-warm-adopt-097 | OK | 9194.2 | no | 1496.1 | 108 (0x6c) @11485.1 | 4003.8 | 4004.5 | 108 (0x6c) @13526.5 | no | 9190.1 | 7693714677591019680 |
| normal-3-warm-adopt-099 | OK | 175.2 | no | — | — | — | — | — | no | 168.7 | 7693714767684384448 |
| normal-4-warm-adopt-001 | OK | 170.7 | no | — | — | — | — | — | no | 288.1 | 7693714834512536460 |
| normal-4-warm-adopt-003 | OK | 204.6 | no | — | — | — | — | — | no | 223.9 | 7693714840325822968 |
| normal-4-warm-adopt-005 | OK | 179.2 | no | — | — | — | — | — | no | 189.8 | 7693714852969674456 |
| normal-4-warm-adopt-007 | OK | 1692.1 | no | 1500.3 | 108 (0x6c) @5957 | 4005.8 | — | — | no | 1682.1 | 7693714877535705764 |
| normal-4-warm-adopt-009 | OK | 4168.3 | no | 1499.1 | 108 (0x6c) @8372.1 | 4004.2 | 4004.9 | 108 (0x6c) @10885 | no | 4168.9 | 7693714917125773628 |
| normal-4-warm-adopt-011 | OK | 6715.5 | no | 1496.3 | 108 (0x6c) @10944.9 | 4007 | 4008.2 | 108 (0x6c) @13437.2 | no | 6716.1 | 7693714978058322148 |
| normal-4-warm-adopt-013 | OK | 9192.9 | no | 1490.2 | 108 (0x6c) @13376.8 | 3989.8 | 3990.6 | 108 (0x6c) @15876.9 | no | 9178.6 | 7693715062858455236 |
| normal-4-warm-adopt-015 | OK | 11715.9 | no | 1496.3 | 108 (0x6c) @15909.1 | 4000.1 | 4001 | 108 (0x6c) @18425.6 | no | 11704.8 | 7693715166711993592 |
| normal-4-warm-adopt-017 | OK | 11726.5 | no | 1518.6 | — | 4023 | 4025.2 | — | no | 11738.1 | 7693715294447248444 |
| normal-4-warm-adopt-019 | OK | 162.3 | no | — | — | — | — | — | no | 159.3 | 7693715367881219844 |
| normal-4-warm-adopt-021 | OK | 177 | no | — | — | — | — | — | no | 179.7 | 7693715380327570856 |
| normal-4-warm-adopt-023 | OK | 1670.7 | no | 1505.6 | 108 (0x6c) @5894.5 | 4010.2 | — | — | no | 1673.1 | 7693715402712868284 |
| normal-4-warm-adopt-025 | OK | 4195.6 | no | 1502.8 | 108 (0x6c) @8385.8 | 4008.6 | 4010.9 | 108 (0x6c) @10885.9 | no | 4190.3 | 7693715442124609480 |
| normal-4-warm-adopt-027 | OK | 6699.6 | no | 1533.3 | 108 (0x6c) @10934.3 | 4041.3 | 4041.9 | 108 (0x6c) @13442.2 | no | 6721.7 | 7693715505682691396 |
| normal-4-warm-adopt-029 | OK | 8999.5 | no | 1493.9 | 108 (0x6c) @13232 | 4046.6 | 4048.5 | 108 (0x6c) @15750 | no | 8994.6 | 7693715590506399804 |
| normal-4-warm-adopt-031 | OK | 94.2 | no | — | — | — | — | — | no | 90.8 | 7693715668451348352 |
| normal-4-warm-adopt-033 | OK | 182.5 | no | — | — | — | — | — | no | 197.1 | 7693715680799397452 |
| normal-4-warm-adopt-035 | OK | 1667.8 | no | 1500.5 | 108 (0x6c) @5884.3 | 4005.6 | — | — | no | 1665.1 | 7693715703758706828 |
| normal-4-warm-adopt-037 | OK | 4173.4 | no | 1501.5 | 108 (0x6c) @8378.9 | 4005.7 | 4006.5 | 108 (0x6c) @10881.1 | no | 4167.8 | 7693715745343468292 |
| normal-4-warm-adopt-039 | OK | 6689.4 | no | 1518.5 | 108 (0x6c) @10903 | 4022.1 | 4022.9 | 108 (0x6c) @13409.2 | no | 6700.7 | 7693715806244611216 |
| normal-4-warm-adopt-041 | OK | 9127.3 | no | 1508.1 | 108 (0x6c) @10817.6 | 4010.5 | 4011.2 | 108 (0x6c) @13316.4 | no | 9126.4 | 7693715888641875964 |
| normal-4-warm-adopt-043 | OK | 170.9 | 87.7 | — | — | — | — | — | no | 168.7 | 7693715968962737140 |
| normal-4-warm-adopt-045 | OK | 228.7 | no | — | — | — | — | — | no | 226 | 7693715981589647480 |
| normal-4-warm-adopt-047 | OK | 1744.2 | no | 1508.1 | 108 (0x6c) @5964.2 | 4018.6 | — | — | no | 1752.1 | 7693716004010391504 |
| normal-4-warm-adopt-049 | OK | 4189.5 | no | 1548.5 | 108 (0x6c) @8444.1 | 4056.2 | 4056.9 | 108 (0x6c) @10958.2 | no | 4235 | 7693716045839874636 |
| normal-4-warm-adopt-051 | OK | 6702 | no | 1491.1 | 108 (0x6c) @10887.2 | 3997.2 | 4001.1 | 108 (0x6c) @13399.6 | no | 6685.7 | 7693716106718178764 |
| normal-4-warm-adopt-053 | OK | 9151.6 | no | 1504.5 | 108 (0x6c) @10852.9 | 4010 | 4010.8 | 108 (0x6c) @13369.4 | no | 9151.7 | 7693716189144818608 |
| normal-4-warm-adopt-055 | OK | 208.8 | no | — | — | — | — | — | no | 205.5 | 7693716269648276184 |
| normal-4-warm-adopt-057 | OK | 94.1 | no | — | — | — | — | — | no | 95.8 | 7693716282235307324 |
| normal-4-warm-adopt-059 | OK | 1657.4 | no | 1497.3 | 108 (0x6c) @5854.1 | 4006.7 | — | — | no | 1661.7 | 7693716304217652268 |
| normal-4-warm-adopt-061 | OK | 4189.5 | no | 1497.9 | 108 (0x6c) @8446.1 | 4005 | 4005.8 | 108 (0x6c) @10952.2 | no | 4181.2 | 7693716343543237820 |
| normal-4-warm-adopt-063 | OK | 6679.3 | no | 1506.2 | 108 (0x6c) @10883.7 | 4011.2 | 4011.8 | 108 (0x6c) @13391.8 | no | 6683.1 | 7693716406711493148 |
| normal-4-warm-adopt-065 | OK | 9200.2 | no | 1501 | 108 (0x6c) @10885.2 | 4003.5 | 4004.2 | 108 (0x6c) @13407.3 | no | 9198.4 | 7693716489113156360 |
| normal-4-warm-adopt-067 | OK | 181.6 | no | — | — | — | — | — | no | 201 | 7693716570285370240 |
| normal-4-warm-adopt-069 | OK | 89.3 | no | — | — | — | — | — | no | 95.1 | 7693716582924907296 |
| normal-4-warm-adopt-071 | OK | 1665.1 | no | 1504.9 | 108 (0x6c) @5864 | 4004.5 | — | — | no | 1670.3 | 7693716604917442044 |
| normal-4-warm-adopt-073 | OK | 4219.6 | no | 1526.9 | 108 (0x6c) @8422.1 | 4041.3 | 4043.1 | 108 (0x6c) @10933.9 | no | 4235.8 | 7693716644302156984 |
| normal-4-warm-adopt-075 | OK | 6686.5 | no | 1497 | 108 (0x6c) @10891.5 | 3999 | 3999.7 | 108 (0x6c) @13404.7 | no | 6686.1 | 7693716707969659732 |
| normal-4-warm-adopt-077 | OK | 9101 | no | 1501.3 | 108 (0x6c) @10829 | 4002.1 | 4003.5 | 108 (0x6c) @13328.2 | no | 9097.7 | 7693716790423580576 |
| normal-4-warm-adopt-079 | OK | 163.3 | no | — | — | — | — | — | no | 153.2 | 7693716871029612984 |
| normal-4-warm-adopt-081 | OK | 181.9 | no | — | — | — | — | — | no | 178.1 | 7693716883472115832 |
| normal-4-warm-adopt-083 | OK | 1679.8 | no | 1495.6 | 108 (0x6c) @6072.3 | 4003.2 | — | — | no | 1684.2 | 7693716905649355988 |
| normal-4-warm-adopt-085 | OK | 4216.3 | no | 1510.2 | 108 (0x6c) @8453.7 | 4016.8 | 4018.1 | 108 (0x6c) @10906.1 | no | 4212.1 | 7693716947638288476 |
| normal-4-warm-adopt-087 | OK | 6703.4 | no | 1510.1 | 108 (0x6c) @10902.9 | 4016.5 | 4017.2 | 108 (0x6c) @13406.2 | no | 6703.1 | 7693717008550227876 |
| normal-4-warm-adopt-089 | OK | 9002.4 | no | 1499.8 | 108 (0x6c) @13188.3 | 4004.7 | 4005.7 | 108 (0x6c) @15706.1 | no | 9003.7 | 7693717091171694060 |
| normal-4-warm-adopt-091 | OK | 164.7 | no | — | — | — | — | — | no | 156 | 7693717171888995460 |
| normal-4-warm-adopt-093 | OK | 197.8 | no | — | — | — | — | — | no | 217.6 | 7693717184559899428 |
| normal-4-warm-adopt-095 | OK | 1680 | no | 1504 | 108 (0x6c) @5901.4 | 4017.4 | — | — | no | 1676.5 | 7693717206955510308 |
| normal-4-warm-adopt-097 | OK | 4190.2 | no | 1500.1 | 108 (0x6c) @8377 | 4005.8 | 4007.1 | 108 (0x6c) @10888.1 | no | 4181.9 | 7693717248617563284 |
| normal-4-warm-adopt-099 | OK | 6711 | no | 1526.8 | 108 (0x6c) @10924.5 | 4038.1 | 4039.8 | 108 (0x6c) @13433.6 | no | 6728 | 7693717309531254120 |
| suppress-1-warm-adopt-001 | OK | 190.7 | no | — | — | — | — | — | no | 297.9 | 7693719615773791608 |
| suppress-1-warm-adopt-003 | OK | 166.2 | no | — | — | — | — | — | no | 173.9 | 7693719620727160840 |
| suppress-1-warm-adopt-005 | OK | 171.6 | no | — | — | — | — | — | no | 177.3 | 7693719633574177868 |
| suppress-1-warm-adopt-007 | HarnessTimeout | >14991.8 (censurado) | no | — | — | — | — | — | no | — | 7693719658050245568 |
| suppress-1-warm-adopt-008 | OK | 173.5 | no | — | — | — | — | — | no | 296.4 | 7693719748275685448 |
| suppress-1-warm-adopt-010 | OK | 164.8 | no | — | — | — | — | — | no | 175.6 | 7693719753646918496 |
| suppress-1-warm-adopt-012 | OK | 181.9 | no | — | — | — | — | — | no | 185 | 7693719766353335152 |
| suppress-1-warm-adopt-014 | HarnessTimeout | 10874.6 | no | — | — | — | — | — | no | 10872.1 | 7693719790904724152 |
| suppress-1-warm-adopt-015 | OK | 169.2 | no | — | — | — | — | — | no | 290.9 | 7693719882998994368 |
| suppress-1-warm-adopt-017 | OK | 169.6 | no | — | — | — | — | — | no | 173.1 | 7693719890636924040 |
| suppress-1-warm-adopt-019 | OK | 171.3 | no | — | — | — | — | — | no | 175.9 | 7693719903271972172 |
| early-1-warm-adopt-001 | OK | 176.6 | no | 249.1 | 108 (0x6c) @335.3 | — | — | — | no | 312.8 | 7693717463686954852 |
| early-1-warm-adopt-003 | OK | 169.2 | no | 104.1 | 108 (0x6c) @351.1 | — | — | — | no | 167.9 | 7693717468734334868 |
| early-1-warm-adopt-005 | OK | 170.6 | no | 126 | 108 (0x6c) @1902.7 | — | — | — | no | 189.3 | 7693717481609035072 |
| early-1-warm-adopt-007 | OK | 274.2 | no | 108.6 | 108 (0x6c) @4478.8 | 2620.6 | — | — | no | 271.9 | 7693717506588266444 |
| early-1-warm-adopt-009 | OK | 2771.1 | no | 101.3 | 108 (0x6c) @6997.7 | 2607.5 | 2609.4 | 108 (0x6c) @9513.1 | no | 2772.5 | 7693717540830582212 |
| early-1-warm-adopt-011 | OK | 5299.8 | no | 118.4 | 108 (0x6c) @9764.5 | 2626.3 | 2629.3 | 108 (0x6c) @12277.6 | no | 5320.2 | 7693717596717430120 |
| early-1-warm-adopt-013 | OK | 5281.4 | no | 166.2 | 108 (0x6c) @9533.3 | 2680.1 | 2681.1 | — | no | 5348.8 | 7693717674729389908 |
| early-1-warm-adopt-015 | OK | 179.4 | no | 107.4 | 108 (0x6c) @383.4 | — | — | — | no | 188.1 | 7693717726235438316 |
| early-1-warm-adopt-017 | OK | 170.7 | no | 102.8 | 108 (0x6c) @1863.2 | — | — | — | no | 168.2 | 7693717738759727852 |
| early-1-warm-adopt-019 | OK | 196.3 | no | 89.3 | 108 (0x6c) @4368.6 | 2594.3 | — | — | no | 183.8 | 7693717760855473404 |
| early-1-warm-adopt-021 | OK | 2799.9 | no | 106.3 | 108 (0x6c) @7022.7 | 2618.2 | 2619.3 | 108 (0x6c) @9559.2 | no | 2807.9 | 7693717794867090252 |
| early-1-warm-adopt-023 | OK | 5289.7 | no | 94.9 | 108 (0x6c) @9471.6 | 2599.9 | 2600.7 | 108 (0x6c) @11978.1 | no | 5286.1 | 7693717850634563584 |
| early-1-warm-adopt-025 | OK | 7786.2 | no | 95.2 | 108 (0x6c) @11995.7 | 2598 | 2599.4 | 108 (0x6c) @12644.3 | no | 7781.7 | 7693717928084317140 |
| early-1-warm-adopt-027 | OK | 748.9 | no | 497.8 | 2 (0x02) @577.9 | — | 692.4 | 108 (0x6c) @774.1 | sí (1) | 745.5 | 7693718017152504452, 7693718018383493884 |
| early-1-warm-adopt-029 | OK | 305.3 | 144 | 122.6 | 108 (0x6c) @526.2 | — | — | — | no | 327.4 | 7693718023154567036 |
| early-1-warm-adopt-031 | OK | 174.4 | no | 98.4 | 108 (0x6c) @1894.4 | — | — | — | no | 177.3 | 7693718035934425444 |
| early-1-warm-adopt-033 | OK | 207.5 | no | 112.7 | 108 (0x6c) @4398.7 | 2617.7 | — | — | no | 209.7 | 7693718060335068892 |
| early-1-warm-adopt-035 | OK | 2792.7 | no | 138.6 | 108 (0x6c) @7067.2 | 2651.7 | 2656.9 | 108 (0x6c) @9552.3 | no | 2831.6 | 7693718094516370948 |
| early-1-warm-adopt-037 | OK | 5289.9 | no | 97.4 | 108 (0x6c) @9480.4 | 2598.1 | 2600 | 108 (0x6c) @11984.6 | no | 5281.8 | 7693718150315175480 |
| early-1-warm-adopt-039 | OK | 7823.5 | no | 122.7 | 108 (0x6c) @12051.4 | 2623.7 | 2624.6 | 108 (0x6c) @12428.1 | no | 7839.1 | 7693718228107192864 |
| early-1-warm-adopt-041 | OK | 181.1 | 207.5 | 126.7 | 44 (0x2c) @206 | — | — | — | no | 308.4 | 7693718315086564208 |
| early-1-warm-adopt-043 | OK | 178.8 | no | 97.4 | 108 (0x6c) @383.3 | — | — | — | no | 173.6 | 7693718322361523620 |
| early-1-warm-adopt-045 | OK | 95 | no | — | — | — | — | — | no | 92.7 | 7693718332664871628 |
| early-1-warm-adopt-047 | OK | 262.3 | no | 102.1 | 108 (0x6c) @4457.4 | 2603.7 | — | — | no | 262.4 | 7693718356855277588 |
| early-1-warm-adopt-049 | OK | 2796 | no | 90 | 108 (0x6c) @6991.6 | 2598.7 | 2601.3 | 108 (0x6c) @9516.6 | no | 2792.2 | 7693718391039026496 |
| early-1-warm-adopt-051 | OK | 5324.3 | no | 92.4 | 108 (0x6c) @9551.9 | 2599.1 | 2602.1 | 108 (0x6c) @12062.9 | no | 5310.4 | 7693718446812845588 |
| early-1-warm-adopt-053 | OK | 7888.6 | no | 113.3 | 108 (0x6c) @12084.9 | 2621.7 | 2622.7 | 108 (0x6c) @12768.8 | no | 7900.1 | 7693718524273273580 |
| early-1-warm-adopt-055 | OK | 634 | no | 90.6 | — | — | 374.9 | 2 (0x02) @455.3 | sí (1) | 626.5 | 7693718611363853804, 7693718614540913760 |
| early-1-warm-adopt-057 | OK | 88.6 | no | — | — | — | — | — | no | 106.8 | 7693718619349444160 |
| early-1-warm-adopt-059 | OK | 187.1 | no | 112.5 | 108 (0x6c) @1932.6 | — | — | — | no | 199.7 | 7693718631869778312 |
| early-1-warm-adopt-061 | OK | 274.6 | no | 106.4 | 108 (0x6c) @4490.5 | 2605.5 | — | — | no | 272.7 | 7693718654090862412 |
| early-1-warm-adopt-063 | OK | 2777.4 | no | 116.3 | 108 (0x6c) @7063.9 | 2618.9 | 2620.4 | 108 (0x6c) @9565 | no | 2794.2 | 7693718688312279360 |
| early-1-warm-adopt-065 | OK | 5323.3 | no | 113.5 | 108 (0x6c) @9523.2 | 2654 | 2655 | 108 (0x6c) @12033.2 | no | 5334.7 | 7693718744453195436 |
| early-1-warm-adopt-067 | OK | 7797 | no | 101.4 | 108 (0x6c) @12025.3 | 2610.5 | 2611.6 | 108 (0x6c) @12278.5 | no | 7793.4 | 7693718821773031756 |
| early-1-warm-adopt-069 | OK | 169.5 | 120.5 | 85.8 | 108 (0x6c) @205.6 | — | — | — | no | 203.5 | 7693718911012832828 |
| early-1-warm-adopt-071 | OK | 177.1 | no | 87.3 | 108 (0x6c) @354.7 | — | — | — | no | 89.5 | 7693718916029564296 |
| early-1-warm-adopt-073 | OK | 257.9 | no | 101.7 | 108 (0x6c) @1998.8 | — | — | — | no | 250.5 | 7693718928746812308 |
| early-1-warm-adopt-075 | OK | 277.9 | no | 98.1 | 108 (0x6c) @4493.3 | 2606.7 | — | — | no | 275.5 | 7693718953365301628 |
| early-1-warm-adopt-077 | OK | 2788.7 | no | 111.6 | 108 (0x6c) @7001.1 | 2620 | 2622.8 | 108 (0x6c) @9507.6 | no | 2788.1 | 7693718988001849604 |
| early-1-warm-adopt-079 | OK | 5300.2 | no | 111.4 | 108 (0x6c) @9507.8 | 2623.4 | 2625.9 | 108 (0x6c) @12023.8 | no | 5304.4 | 7693719043800802688 |
| early-1-warm-adopt-081 | OK | 7815.7 | no | 110.4 | 108 (0x6c) @12017.8 | 2616 | 2616.9 | 108 (0x6c) @12353.8 | no | 7814.1 | 7693719121028273996 |
| early-1-warm-adopt-083 | OK | 171.1 | 295.7 | 207.9 | 44 (0x2c) @293.1 | — | — | — | no | 380 | 7693719208097912028 |
| early-1-warm-adopt-085 | OK | 159.5 | no | 101.9 | 108 (0x6c) @351.1 | — | — | — | no | 153.6 | 7693719215517703692 |
| early-1-warm-adopt-087 | OK | 176.9 | no | 105.2 | 108 (0x6c) @1884.5 | — | — | — | no | 182 | 7693719225816661092 |
| early-1-warm-adopt-089 | OK | 283.1 | no | 114.1 | 108 (0x6c) @4507.4 | 2622.1 | — | — | no | 286.2 | 7693719250227416988 |
| early-1-warm-adopt-091 | OK | 2789.7 | no | 111.9 | 108 (0x6c) @6988.4 | 2622.4 | 2625.1 | 108 (0x6c) @9514 | no | 2787.9 | 7693719284537088900 |
| early-1-warm-adopt-093 | OK | 5325.7 | no | 117.9 | 108 (0x6c) @9524.7 | 2627.2 | 2628.6 | 108 (0x6c) @12025.4 | no | 5336.1 | 7693719340321291592 |
| early-1-warm-adopt-095 | OK | 7785 | no | 114.1 | 108 (0x6c) @12017.2 | 2616.5 | 2617.5 | 108 (0x6c) @12506.9 | no | 7790.8 | 7693719417813105492 |
| early-1-warm-adopt-097 | OK | 169.5 | 432.6 | 344.5 | 44 (0x2c) @429.6 | — | — | — | no | 514.9 | 7693719504712791240 |
| early-1-warm-adopt-099 | OK | 192 | no | 105.1 | 108 (0x6c) @392.3 | — | — | — | no | 197.4 | 7693719512518362136 |

## Timelines representativos

### <500 ms: normal-2-warm-adopt-093 (175.7 ms)

- +5.4 ms · C_RPC_CREATED
- +5.4 ms · C_RPC_ENQUEUE
- +6.7 ms · C_RPC_MSG_ID_ASSIGNED · msg_id 7693679233675473660
- +6.7 ms · C_GET_STATE_SCHEDULED · msg_id 7693679233675473660
- +15.1 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED
- +192.5 ms · WORKER_GET_FILE_RPC_RESULT_ENTER
- +192.6 ms · C_RPC_RESULT · msg_id 7693679233675473660
- +192.7 ms · C_ACK_APPLIED · msg_id 7693679233675473660
- +192.7 ms · C_ACK_APPLIED · msg_id 7693679233675473660

### 500–2500 ms: normal-3-warm-adopt-007 (1654.1 ms)

- -10.6 ms · C_RPC_CREATED
- -10.5 ms · C_RPC_ENQUEUE
- +3.5 ms · C_RPC_MSG_ID_ASSIGNED · msg_id 7693712360915458276
- +6.1 ms · C_GET_STATE_SCHEDULED · msg_id 7693712360915458276
- +9.2 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED
- +1496.3 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712366258841252
- +1498 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712366258841252
- +1667 ms · WORKER_GET_FILE_RPC_RESULT_ENTER
- +1667.2 ms · C_RPC_RESULT · msg_id 7693712360915458276
- +1667.4 ms · C_ACK_APPLIED · msg_id 7693712360915458276
- +1667.5 ms · C_ACK_APPLIED · msg_id 7693712360915458276
- +4009.8 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712366258841252
- +5941.8 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712366258841252 · estado 108

### 2.5–5 s: normal-3-warm-adopt-009 (4178.3 ms)

- -8.1 ms · C_RPC_CREATED
- -8.1 ms · C_RPC_ENQUEUE
- +9.1 ms · C_RPC_MSG_ID_ASSIGNED · msg_id 7693712400459485520
- +9.2 ms · C_GET_STATE_SCHEDULED · msg_id 7693712400459485520
- +11.6 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED
- +1509.1 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712408028004852
- +1509.5 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712408028004852
- +4013.8 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712408028004852
- +4015.7 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712417678980284
- +4017.3 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712417678980284
- +4192.7 ms · WORKER_GET_FILE_RPC_RESULT_ENTER
- +4192.9 ms · C_RPC_RESULT · msg_id 7693712400459485520
- +4193.1 ms · C_ACK_APPLIED · msg_id 7693712400459485520
- +4193.9 ms · C_ACK_APPLIED · msg_id 7693712400459485520
- +6520.8 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712417678980284
- +8391 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712408028004852 · estado 108
- +10910.2 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712417678980284 · estado 108

### 5–7.5 s: normal-3-warm-adopt-011 (6687.7 ms)

- -7.2 ms · C_RPC_CREATED
- -7.2 ms · C_RPC_ENQUEUE
- -5.5 ms · C_RPC_MSG_ID_ASSIGNED · msg_id 7693712461274772660
- -5.4 ms · C_GET_STATE_SCHEDULED · msg_id 7693712461274772660
- -4.5 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED
- +1509.6 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712468838841852
- +1510.8 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712468838841852
- +4012.4 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712468838841852
- +4012.9 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712478494233604
- +4013.1 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712478494233604
- +6522.1 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712478494233604
- +6522.7 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712490351514156
- +6523 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712490351514156
- +6684.2 ms · WORKER_GET_FILE_RPC_RESULT_ENTER
- +6684.4 ms · C_RPC_RESULT · msg_id 7693712461274772660
- +6684.4 ms · C_ACK_APPLIED · msg_id 7693712461274772660
- +6684.5 ms · C_ACK_APPLIED · msg_id 7693712461274772660
- +9032.3 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712490351514156
- +10886.2 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712468838841852 · estado 108
- +13413.2 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712478494233604 · estado 108
- +15897 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712490351514156 · estado 108

### 7.5–10 s: normal-3-warm-adopt-025 (9185.2 ms)

- -6.2 ms · C_RPC_CREATED
- -6.1 ms · C_RPC_ENQUEUE
- +8.7 ms · C_RPC_MSG_ID_ASSIGNED · msg_id 7693712812671245000
- +9.4 ms · C_GET_STATE_SCHEDULED · msg_id 7693712812671245000
- +13.7 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED
- +1506.3 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712820233732636
- +1506.7 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712820233732636
- +4008.3 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712820233732636
- +4008.8 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712829880663140
- +4009.2 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712829880663140
- +6511 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712829880663140
- +6511.5 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712841720905580
- +6511.6 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712841720905580
- +9023.2 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712841720905580
- +9023.7 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693712851386927972
- +9023.9 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693712851386927972
- +9199.9 ms · WORKER_GET_FILE_RPC_RESULT_ENTER
- +9200 ms · C_RPC_RESULT · msg_id 7693712812671245000
- +9200.1 ms · C_ACK_APPLIED · msg_id 7693712812671245000
- +9200.1 ms · C_ACK_APPLIED · msg_id 7693712812671245000
- +11383.5 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712820233732636 · estado 108
- +11531.8 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693712851386927972
- +13410.4 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712829880663140 · estado 108
- +15904.1 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712841720905580 · estado 108
- +18418.9 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693712851386927972 · estado 108
- +19705.8 ms · C_DETAILED_INFO · msg_id 7693712812671245000
- +19705.9 ms · C_DETAILED_INFO · msg_id 7693712545833938392
- +92149.3 ms · C_DETAILED_INFO · msg_id 7693712812671245000
- +164690.9 ms · C_DETAILED_INFO · msg_id 7693712812671245000
- +237089.6 ms · C_DETAILED_INFO · msg_id 7693712812671245000
- +309454.4 ms · C_DETAILED_INFO · msg_id 7693712812671245000
- +381946.4 ms · C_DETAILED_INFO · msg_id 7693712812671245000
- +454313.2 ms · C_DETAILED_INFO · msg_id 7693712812671245000

### >10 s: normal-4-warm-adopt-015 (11715.9 ms)

- -18.2 ms · C_RPC_CREATED
- -18.1 ms · C_RPC_ENQUEUE
- -16.4 ms · C_RPC_MSG_ID_ASSIGNED · msg_id 7693715166711993592
- -16.3 ms · C_GET_STATE_SCHEDULED · msg_id 7693715166711993592
- -12.3 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED
- +1496.1 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693715174276012076
- +1496.3 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693715174276012076
- +4000.1 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693715174276012076
- +4000.7 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693715183927217164
- +4001 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693715183927217164
- +6514.9 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693715183927217164
- +6515.4 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693715195794985652
- +6515.6 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693715195794985652
- +9029.7 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693715195794985652
- +9030.4 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693715205464984924
- +9030.7 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693715205464984924
- +11538.5 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693715205464984924
- +11539 ms · C_STATE_REQ_CONNECTION_SEND · state_msg_id 7693715217317921796
- +11539.2 ms · C_STATE_REQ_WEBSOCKET_SEND · state_msg_id 7693715217317921796
- +11704.7 ms · WORKER_GET_FILE_RPC_RESULT_ENTER
- +11704.8 ms · C_RPC_RESULT · msg_id 7693715166711993592
- +11704.9 ms · C_ACK_APPLIED · msg_id 7693715166711993592
- +11704.9 ms · C_ACK_APPLIED · msg_id 7693715166711993592
- +14046.7 ms · C_STATE_REQ_TIMEOUT · state_msg_id 7693715217317921796
- +15909.1 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693715174276012076 · estado 108
- +18425.6 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693715183927217164 · estado 108
- +20925.9 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693715195794985652 · estado 108
- +23448.8 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693715205464984924 · estado 108
- +25932.9 ms · C_STATE_INFO_RECEIVED · state_msg_id 7693715217317921796 · estado 108

## Variantes

| Variante | RPC físicos | Respuesta | Censurados | p50 | p95 | max | tails ≥6 s | con state_req | info previa | estado 2 | requeue | resultado sin state_req |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| normal | 200 | 200 | 0 | 1706.6 | 9212.5 | 11740.6 | 65 | 129 | 0 | 0 | 0 | 71 |
| suppress | 11 | 10 | 1 | 171.3 | 10874.6 | 10874.6 | 1 | 0 | 0 | 0 | 0 | 10 |
| early | 50 | 50 | 0 | 277.9 | 7815.7 | 7888.6 | 6 | 48 | 5 | 2 | 2 | 2 |
