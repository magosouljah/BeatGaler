# Test D · conexión MTProto y WARM

Resultados generados desde las trazas crudas locales de `traces/`, ignoradas por Git.

## Metodología

Cuenta 03, mensaje 96 (`Stage1 Playback v2 03.mp3`, 17 136 bytes) y competidor 101 (archivo de 64 MiB). Sesión/peer y, en raw, descriptores de ambos mensajes se prepararon fuera de `START`. Cada intento raw pidió 64 KiB desde offset 0 mediante `TelegramClient.downloadChunk` real; D1 hizo solo el RPC 96 durante el run. WARM usó el batch de producción `[96,101]`, foco 96 y 10 ms de anticipación. D3 cambió únicamente el RPC 101 a `kind:"download"` dentro del worker experimental; el 96 siguió en `main`. Las series se ejecutaron secuencialmente.

Un RPC físico exige `D_RPC_WEBSOCKET_SEND` y `D_RPC_RESULT` con el mismo `msg_id`. Un par válido requiere ambos RPC completos y run `OK`; “solapado” significa que ambos se enviaron antes de la primera de sus respuestas. Los percentiles son nearest-rank. Los hits de rango WARM y los runs fallidos no se convierten en RPC de 0 ms. `session_tag` es un hash truncado, suficiente para comparar sesiones sin guardar su valor crudo. `packet_id` identifica un flush/paquete MTProto; `ws_send_id` una escritura WebSocket física.

## Comparación principal (RPC físico 96 completo, runs `OK`)

| Caso | Runs lógicos | RPC físicos 96 | p50 / p95 / max (ms) | ≥3 / ≥6 / ≥9 s | State recovery | Pares físicos válidos | Solapados | Escritura WebSocket conjunta |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| D1 · 96 solo | 100 | 100 | 1678.9 / 1720.5 / 2376.2 | 0 / 0 / 0 | 99 | 0 | 0 | 0 |
| D2 · WARM mismo socket | 200 | 100 | 1746.3 / 9183.4 / 11714.2 | 50 / 34 / 6 | 66 | 100 | 98 | 98 |
| D3 · WARM sockets separados | 200 | 100 | 175.7 / 249.8 / 281.2 | 0 / 0 / 0 | 0 | 100 | 98 | 0 |
| D2 · raw simultáneo mismo socket | 110 | 109 | 6680.7 / 14016.5 / 14231.4 | 75 / 58 / 43 | 94 | 109 | 109 | 109 |
| D3 · raw simultáneo sockets separados | 100 | 100 | 167.8 / 197.8 / 297.1 | 0 / 0 / 0 | 0 | 100 | 100 | 0 |

## RPC físico 101 completo

| Caso | RPC físicos 101 | p50 / p95 / max (ms) | ≥3 / ≥6 / ≥9 s | State recovery |
|---|---:|---:|---:|---:|
| D2 · WARM mismo socket | 198 | 4463 / 11869.2 / 16805.7 | 118 / 86 / 43 | 84 |
| D3 · WARM sockets separados | 198 | 254.3 / 466.5 / 609.6 | 0 / 0 / 0 | 0 |
| D2 · raw mismo socket | 109 | 9286.5 / 14456.6 / 16839.6 | 94 / 74 / 58 | 109 |
| D3 · raw sockets separados | 100 | 176.8 / 215.2 / 309.8 | 0 / 0 / 0 | 0 |

## Series individuales

| Serie | Runs | RPC físicos completos 96 | 96 p50 / p95 / max (ms) | 96 ≥3 / ≥6 / ≥9 s | Recovery 96 | RPC físicos completos 101 | 101 p50 / p95 / max (ms) | 101 ≥3 / ≥6 / ≥9 s | Recovery 101 | Pares físicos | Solapados | Mismo socket | Diferente socket |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| d1 | 100 | 100 | 1678.9 / 1720.5 / 2376.2 | 0 / 0 / 0 | 99 | 0 | — / — / — | 0 / 0 / 0 | 0 | 0 | 0 | 0 | 0 |
| d2-warm | 100 | 50 | 1720.6 / 9183.4 / 11714.2 | 25 / 17 / 3 | 33 | 99 | 4464.1 / 11869.2 / 16805.4 | 59 / 43 / 21 | 42 | 50 | 49 | 50 | 0 |
| d2-warm-repeat | 100 | 50 | 1746.3 / 9205.1 / 11714.2 | 25 / 17 / 3 | 33 | 99 | 4463 / 11952.6 / 16805.7 | 59 / 43 / 22 | 42 | 50 | 49 | 50 | 0 |
| d3-warm | 100 | 50 | 172 / 200.4 / 250 | 0 / 0 / 0 | 0 | 99 | 183.8 / 295.8 / 356 | 0 / 0 / 0 | 0 | 50 | 49 | 0 | 50 |
| d3-warm-repeat | 100 | 50 | 187.3 / 267.1 / 281.2 | 0 / 0 / 0 | 0 | 99 | 327.9 / 495.7 / 609.6 | 0 / 0 / 0 | 0 | 50 | 49 | 0 | 50 |
| d2-raw-a | 60 | 59 | 6680.7 / 11730.7 / 14204.4 | 41 / 32 / 23 | 51 | 59 | 9286.5 / 14402.8 / 16116 | 51 / 41 / 32 | 59 | 59 | 59 | 59 | 0 |
| d2-raw-b | 50 | 50 | 6678.1 / 14214.3 / 14231.4 | 34 / 26 / 20 | 43 | 50 | 9283.9 / 14518.7 / 16839.6 | 43 / 33 / 26 | 50 | 50 | 50 | 50 | 0 |
| d3-raw | 100 | 100 | 167.8 / 197.8 / 297.1 | 0 / 0 / 0 | 0 | 100 | 176.8 / 215.2 / 309.8 | 0 / 0 / 0 | 0 | 100 | 100 | 0 | 100 |
| d4-101-first-0 | 12 | 12 | 160.2 / 213.4 / 213.4 | 0 / 0 / 0 | 0 | 12 | 114.4 / 207.6 / 207.6 | 0 / 0 / 0 | 0 | 12 | 12 | 12 | 0 |
| d4-96-first-0-gated | 12 | 12 | 96.4 / 168.4 / 168.4 | 0 / 0 / 0 | 0 | 12 | 106.4 / 179.2 / 179.2 | 0 / 0 / 0 | 0 | 12 | 12 | 12 | 0 |
| d4-96-first-10 | 12 | 12 | 92.5 / 176.8 / 176.8 | 0 / 0 / 0 | 0 | 12 | 107.5 / 201.4 / 201.4 | 0 / 0 / 0 | 0 | 12 | 12 | 12 | 0 |
| d4-101-first-10 | 12 | 12 | 101.7 / 247.5 / 247.5 | 0 / 0 / 0 | 0 | 12 | 110.4 / 200.1 / 200.1 | 0 / 0 / 0 | 0 | 12 | 12 | 12 | 0 |
| d4-96-first-50 | 12 | 12 | 91.2 / 121.9 / 121.9 | 0 / 0 / 0 | 0 | 12 | 117.2 / 202.6 / 202.6 | 0 / 0 / 0 | 0 | 12 | 12 | 12 | 0 |
| d4-101-first-50 | 12 | 12 | 125.3 / 161.1 / 161.1 | 0 / 0 / 0 | 0 | 12 | 102 / 193.1 / 193.1 | 0 / 0 / 0 | 0 | 12 | 12 | 12 | 0 |
| d4-96-first-100 | 12 | 12 | 90.4 / 129.7 / 129.7 | 0 / 0 / 0 | 0 | 12 | 104.3 / 144.2 / 144.2 | 0 / 0 / 0 | 0 | 12 | 11 | 12 | 0 |
| d4-101-first-100 | 12 | 12 | 101.4 / 137.7 / 137.7 | 0 / 0 / 0 | 0 | 12 | 115.1 / 192.5 / 192.5 | 0 / 0 / 0 | 0 | 12 | 12 | 12 | 0 |
| d4-101-first-coalesced | 20 | 20 | 6838.4 / 14271 / 16728.3 | 18 / 14 / 10 | 20 | 20 | 6761.1 / 12537.3 / 14335.4 | 15 / 11 / 8 | 18 | 20 | 20 | 20 | 0 |
| d4-sequential | 20 | 20 | 1677 / 1786.9 / 1940.9 | 0 / 0 / 0 | 20 | 20 | 1765.9 / 1800.3 / 1837 | 0 / 0 / 0 | 20 | 20 | 0 | 20 | 0 |

Solo los runs con estado `OK` entran en percentiles, tails y pares válidos. Los runs fallidos se conservan en `analysis.json` y en las trazas.

| Serie | Runs fallidos |
|---|---:|
| d1 | 0 |
| d2-warm | 0 |
| d2-warm-repeat | 0 |
| d3-warm | 0 |
| d3-warm-repeat | 0 |
| d2-raw-a | 1 |
| d2-raw-b | 0 |
| d3-raw | 0 |
| d4-101-first-0 | 0 |
| d4-96-first-0-gated | 0 |
| d4-96-first-10 | 0 |
| d4-101-first-10 | 0 |
| d4-96-first-50 | 0 |
| d4-101-first-50 | 0 |
| d4-96-first-100 | 0 |
| d4-101-first-100 | 0 |
| d4-101-first-coalesced | 0 |
| d4-sequential | 0 |

## Topología física de cada serie

| Serie | Dos RPC en mismo `WebSocket.send` | Mismo paquete MTProto | Mismo container | Mismo DC | Misma sesión MTProto |
|---|---:|---:|---:|---:|---:|
| d1 | 0 | 0 | 0 | 0 | 0 |
| d2-warm | 49 | 0 | 0 | 50 | 50 |
| d2-warm-repeat | 49 | 0 | 0 | 50 | 50 |
| d3-warm | 0 | 0 | 0 | 50 | 0 |
| d3-warm-repeat | 0 | 0 | 0 | 50 | 0 |
| d2-raw-a | 59 | 0 | 0 | 59 | 59 |
| d2-raw-b | 50 | 0 | 0 | 50 | 50 |
| d3-raw | 0 | 0 | 0 | 100 | 0 |
| d4-101-first-0 | 0 | 0 | 0 | 12 | 12 |
| d4-96-first-0-gated | 0 | 0 | 0 | 12 | 12 |
| d4-96-first-10 | 0 | 0 | 0 | 12 | 12 |
| d4-101-first-10 | 0 | 0 | 0 | 12 | 12 |
| d4-96-first-50 | 0 | 0 | 0 | 12 | 12 |
| d4-101-first-50 | 0 | 0 | 0 | 12 | 12 |
| d4-96-first-100 | 0 | 0 | 0 | 12 | 12 |
| d4-101-first-100 | 0 | 0 | 0 | 12 | 12 |
| d4-101-first-coalesced | 20 | 0 | 0 | 20 | 20 |
| d4-sequential | 0 | 0 | 0 | 20 | 20 |

## Identidades de conexión representativas

| Serie/run | 96: pool, conexión, socket, DC, sesión | 101: pool, conexión, socket, DC, sesión |
|---|---|---|
| d2-warm/warm-adopt-001 | main/0/1/DC1/9308558d83cca17d | main/0/1/DC1/9308558d83cca17d |
| d3-warm/warm-adopt-001 | main/0/1/DC1/0c88e5404eed4da7 | download/9/2/DC1/b32f511ff5962ad8 |
| d2-raw-a/test-d-raw-001 | main/0/1/DC1/458db2924a3a458a | main/0/1/DC1/458db2924a3a458a |
| d3-raw/test-d-raw-001 | main/0/1/DC1/44c1b7e98ad7e309 | download/9/2/DC1/4c8cfd8a8394d870 |

## Orden y offset (D4)

| Serie | Primer mensaje | Offset pedido (ms) | Envío físico 96 antes de 101 | 96 ≥6 s | 101 ≥6 s |
|---|---:|---:|---:|---:|---:|
| d4-101-first-0 | 101 | 0 | 0/12 | 0 | 0 |
| d4-96-first-0-gated | 96 | 0 | 12/12 | 0 | 0 |
| d4-96-first-10 | 96 | 10 | 12/12 | 0 | 0 |
| d4-101-first-10 | 101 | 10 | 0/12 | 0 | 0 |
| d4-96-first-50 | 96 | 50 | 12/12 | 0 | 0 |
| d4-101-first-50 | 101 | 50 | 0/12 | 0 | 0 |
| d4-96-first-100 | 96 | 100 | 12/12 | 0 | 0 |
| d4-101-first-100 | 101 | 100 | 0/12 | 0 | 0 |
| d4-101-first-coalesced | 101 | 0 | 0/20 | 14 | 11 |
| d4-sequential | 96 | 0 | 20/20 | 0 | 0 |

## Interpretación causal

En llamadas raw equivalentes, 58/109 RPC del 96 alcanzaron 6 s con 96 y 101 en el mismo socket; al enrutar solo 101 a otro socket fueron 0/100. Ambos grupos solaparon físicamente los dos RPC. Las trazas verifican pool, conexión, socket, DC y sesión MTProto por intento.

Con el batch WARM y foco de producción, los RPC físicos completos del 96 tuvieron 34/100 tails ≥6 s en el mismo socket y 0/100 con sockets distintos. Los demás runs WARM reutilizaron rango; no se computan como RPC de duración cero.

La conexión compartida por sí sola no basta: 109/109 pares raw simultáneos quedaron en una sola escritura WebSocket, frente a 0/96 pares con barrera/offset en el mismo socket. En estos últimos, los RPC siguieron solapados casi siempre y hubo 0 tails del 96 ≥6 s.

Invirtiendo el orden sin barrera, 20/20 pares volvieron a compartir una escritura WebSocket y 14/20 RPC del 96 tuvieron tail ≥6 s. El orden 96/101 no explica por sí solo el fenómeno.

Los dos `upload.getFile` reciben `msg_id` y paquetes MTProto distintos; no comparten flush ni `msg_container`. En las variantes lentas, el `FramedWriter` de `@fuman/io` puede codificar ambos sobre su buffer compartido antes de una sola escritura. La coincidencia entre esa escritura conjunta y el tail es el mecanismo cliente más concreto que muestran estos datos. El experimento no separa tiempo de red, procesamiento Telegram y transporte remoto; tampoco prueba si la demora nace en el writer, en el framing recibido o en la respuesta del servidor.

En BeatGaler, `downloadChunk` de mtcute usa el pool `main` por defecto: la etiqueta de lane «download» del scheduler no selecciona automáticamente el pool MTProto `download`. D3 fuerza **solo en el harness** `kind:"download"` para 101 y prepara ese pool antes de `START`; esto cambia también la sesión MTProto, además del socket. D4 elimina esa confusión al mantener ambos RPC en el mismo socket y variar si comparten escritura.

Arquitectura candidata, aún sin implementar: impedir que dos descargas compartan una escritura concurrente de la misma conexión, mediante serialización del writer por conexión o asignando Play y WARM a conexiones independientes con prioridad acotada. Primero habría que verificar el framing y el comportamiento del writer en una prueba aislada; aumentar timeouts no ataca el mecanismo observado.

Las marcas send→`rpc_result` son del cliente. Los escalones de ~2.5 s incluyen `msgs_state_req`/recovery de mtcute, pero la ausencia de respuesta anterior al primer state request no atribuye el origen de la espera exclusivamente a Telegram. Un run raw fallido por `AUTH_KEY_UNREGISTERED` tras reconexiones quedó fuera de los percentiles y se conservó completo en la traza.

Código inspeccionado: `src/features/cloud/webTransport.worker.ts` (batch, foco, descarga); `node_modules/@mtcute/core/network/session-connection.js` (`_doFlush`, corte especial de `upload.getFile`); `node_modules/@mtcute/core/network/multi-session-connection.js` (selección por carga); `node_modules/@fuman/io/codec/writer.js` (`FramedWriter.write`); `tests/playback-d/instrument.mjs` (probes solo de test).


## Tails del RPC 96 ≥6 s

| Serie/run | Duración (ms) | 96 send→result | 101 send→result | Conexión/socket 96 vs 101 | State req / info / requeue 96 |
|---|---:|---|---|---|---|
| d2-warm/warm-adopt-011 | 6753.2 | 0.9→6754.2 | 1→7047.8 | 0/1 vs 0/1 | 3/3/0 |
| d2-warm/warm-adopt-013 | 9183.4 | 22.2→9205.6 | 22.9→9543 | 0/1 vs 0/1 | 4/4/0 |
| d2-warm/warm-adopt-015 | 11714.2 | 0.7→11715 | 0.8→12036.5 | 0/1 vs 0/1 | 5/5/0 |
| d2-warm/warm-adopt-017 | 11691.7 | -5.3→11686.4 | -5.3→11989.7 | 0/1 vs 0/1 | 5/0/0 |
| d2-warm/warm-adopt-027 | 6703.6 | -3→6700.6 | -2.9→7007.2 | 0/2 vs 0/2 | 3/3/0 |
| d2-warm/warm-adopt-029 | 7771.7 | 25.1→7796.8 | 25.1→8109 | 0/2 vs 0/2 | 3/2/0 |
| d2-warm/warm-adopt-039 | 6678.7 | -2.8→6675.9 | -2.8→6973.4 | 0/3 vs 0/3 | 3/3/0 |
| d2-warm/warm-adopt-041 | 7684.6 | 14.5→7699.1 | 14.5→7988.1 | 0/3 vs 0/3 | 3/2/0 |
| d2-warm/warm-adopt-051 | 6694.9 | 15.8→6710.7 | 15.8→7007.7 | 0/4 vs 0/4 | 3/3/0 |
| d2-warm/warm-adopt-053 | 7576.9 | 44.6→7621.5 | 44.6→7954.6 | 0/4 vs 0/4 | 3/2/0 |
| d2-warm/warm-adopt-063 | 6666.8 | -5.3→6661.5 | -5.3→6954.2 | 0/5 vs 0/5 | 3/3/0 |
| d2-warm/warm-adopt-065 | 7627 | 7.6→7634.6 | 7.6→8106.7 | 0/5 vs 0/5 | 3/2/0 |
| d2-warm/warm-adopt-075 | 6664.2 | -44.9→6619.3 | -44.9→7294.8 | 0/6 vs 0/6 | 3/3/0 |
| d2-warm/warm-adopt-077 | 7591.7 | 2.4→7594.1 | 2.4→7900.1 | 0/6 vs 0/6 | 3/2/0 |
| d2-warm/warm-adopt-087 | 6682.9 | -10.1→6672.8 | -10.1→7094.2 | 0/7 vs 0/7 | 3/3/0 |
| d2-warm/warm-adopt-089 | 7659.7 | -5.9→7653.8 | -5.9→7999.7 | 0/7 vs 0/7 | 3/2/0 |
| d2-warm/warm-adopt-099 | 6701.6 | -14.6→6687 | -14.6→6996 | 0/8 vs 0/8 | 3/3/0 |
| d2-warm-repeat/warm-adopt-011 | 6671 | 3.4→6674.4 | 3.5→6966.4 | 0/1 vs 0/1 | 3/3/0 |
| d2-warm-repeat/warm-adopt-013 | 9205.1 | -16.6→9188.5 | -16.6→9498.4 | 0/1 vs 0/1 | 4/4/0 |
| d2-warm-repeat/warm-adopt-015 | 11708.3 | 9→11717.3 | 9→12002.8 | 0/1 vs 0/1 | 5/5/0 |
| d2-warm-repeat/warm-adopt-017 | 11714.2 | -3.5→11710.7 | -3.5→12050.7 | 0/1 vs 0/1 | 5/0/0 |
| d2-warm-repeat/warm-adopt-027 | 6710.7 | -6.9→6703.8 | -6.9→6993.8 | 0/2 vs 0/2 | 3/3/0 |
| d2-warm-repeat/warm-adopt-029 | 8404.2 | -6→8398.1 | -6→8721.5 | 0/2 vs 0/2 | 3/2/0 |
| d2-warm-repeat/warm-adopt-039 | 6710.8 | -4.5→6706.4 | -4.4→7304.2 | 0/3 vs 0/3 | 3/3/0 |
| d2-warm-repeat/warm-adopt-041 | 8536.6 | 10.3→8546.9 | 10.6→9031.4 | 0/3 vs 0/3 | 3/2/0 |
| d2-warm-repeat/warm-adopt-051 | 6693 | -4.1→6688.8 | -4.1→7011 | 0/4 vs 0/4 | 3/3/0 |
| d2-warm-repeat/warm-adopt-053 | 8582.8 | 10.3→8593.1 | 10.4→8880.3 | 0/4 vs 0/4 | 3/2/0 |
| d2-warm-repeat/warm-adopt-063 | 6752.8 | 8→6760.8 | 8→7182.7 | 0/5 vs 0/5 | 3/3/0 |
| d2-warm-repeat/warm-adopt-065 | 7953.7 | 4.6→7958.3 | 4.6→8821.9 | 0/5 vs 0/5 | 3/2/0 |
| d2-warm-repeat/warm-adopt-075 | 6711 | -4.3→6706.6 | -4.3→7031.5 | 0/6 vs 0/6 | 3/3/0 |
| d2-warm-repeat/warm-adopt-077 | 8181.8 | -7→8174.9 | -6.9→8473 | 0/6 vs 0/6 | 3/2/0 |
| d2-warm-repeat/warm-adopt-087 | 6826.2 | -5.5→6820.7 | -5.5→7347.4 | 0/7 vs 0/7 | 3/3/0 |
| d2-warm-repeat/warm-adopt-089 | 7933.7 | -5.7→7928 | -5.7→8303.4 | 0/7 vs 0/7 | 3/2/0 |
| d2-warm-repeat/warm-adopt-099 | 6720 | 73.1→6793.1 | 73.1→7121.5 | 0/8 vs 0/8 | 3/3/0 |
| d2-raw-a/test-d-raw-003 | 6677.5 | 6.8→6684.3 | 6.9→9290.3 | 0/1 vs 0/1 | 3/0/0 |
| d2-raw-a/test-d-raw-004 | 9207.6 | 5.1→9212.7 | 5.2→11849 | 0/1 vs 0/1 | 4/0/0 |
| d2-raw-a/test-d-raw-005 | 11701.9 | 4.3→11706.3 | 8.7→14291.4 | 0/1 vs 0/1 | 5/0/0 |
| d2-raw-a/test-d-raw-009 | 6692.9 | 3.3→6696.1 | 3.3→9306.3 | 0/2 vs 0/2 | 3/0/0 |
| d2-raw-a/test-d-raw-010 | 9232.9 | 4→9236.8 | 4→11807.6 | 0/2 vs 0/2 | 4/0/0 |
| d2-raw-a/test-d-raw-011 | 11723.1 | 3.2→11726.3 | 3.3→14338 | 0/2 vs 0/2 | 5/0/0 |
| d2-raw-a/test-d-raw-012 | 11707 | 4.1→11711.1 | 4.1→14460.8 | 0/2 vs 0/2 | 5/0/0 |
| d2-raw-a/test-d-raw-016 | 6694.5 | 4.3→6698.8 | 4.3→9372.1 | 0/3 vs 0/3 | 3/0/0 |
| d2-raw-a/test-d-raw-017 | 9201.5 | 3.3→9204.9 | 3.4→11909.4 | 0/3 vs 0/3 | 4/0/0 |
| d2-raw-a/test-d-raw-018 | 11716.8 | 3.4→11720.3 | 3.5→14406.3 | 0/3 vs 0/3 | 5/0/0 |
| d2-raw-a/test-d-raw-019 | 12228.3 | 3.7→12232 | 3.7→14366.8 | 0/3 vs 0/3 | 5/0/0 |
| d2-raw-a/test-d-raw-023 | 6687.4 | 3.8→6691.2 | 3.8→9380 | 0/4 vs 0/4 | 3/0/0 |
| d2-raw-a/test-d-raw-024 | 9199.1 | 4.1→9203.2 | 4.1→11796.4 | 0/4 vs 0/4 | 4/0/0 |
| d2-raw-a/test-d-raw-025 | 11714.1 | 3.4→11717.6 | 3.5→14323.5 | 0/4 vs 0/4 | 5/0/0 |
| d2-raw-a/test-d-raw-026 | 11720.4 | 4.2→11724.6 | 4.2→14321.6 | 0/4 vs 0/4 | 5/0/0 |
| d2-raw-a/test-d-raw-030 | 6680.7 | 4.6→6685.3 | 4.6→9332.7 | 0/5 vs 0/5 | 3/0/0 |
| d2-raw-a/test-d-raw-031 | 9228.2 | 5.2→9233.4 | 5.2→11831.9 | 0/5 vs 0/5 | 4/0/0 |
| d2-raw-a/test-d-raw-032 | 11708.9 | 5→11713.9 | 5→14326.3 | 0/5 vs 0/5 | 5/0/0 |
| d2-raw-a/test-d-raw-033 | 11718.1 | 3.6→11721.7 | 3.6→14323.2 | 0/5 vs 0/5 | 5/0/0 |
| d2-raw-a/test-d-raw-037 | 6679.4 | 4.5→6683.9 | 4.5→9504.1 | 0/6 vs 0/6 | 3/0/0 |
| d2-raw-a/test-d-raw-039 | 11730.7 | 3.9→11734.6 | 3.9→14369.8 | 0/6 vs 0/6 | 5/0/0 |
| d2-raw-a/test-d-raw-040 | 14204.4 | 3.7→14208.1 | 3.7→16119.7 | 0/6 vs 0/6 | 6/0/0 |
| d2-raw-a/test-d-raw-044 | 6695.1 | 5.2→6700.3 | 5.3→9316.2 | 0/7 vs 0/7 | 3/0/0 |
| d2-raw-a/test-d-raw-045 | 9231.6 | 3.9→9235.5 | 3.9→11791.1 | 0/7 vs 0/7 | 4/0/0 |
| d2-raw-a/test-d-raw-046 | 11689.1 | 3.5→11692.7 | 3.6→14290.3 | 0/7 vs 0/7 | 5/0/0 |
| d2-raw-a/test-d-raw-047 | 11685.6 | 4→11689.6 | 4.1→14286.6 | 0/7 vs 0/7 | 5/0/0 |
| d2-raw-a/test-d-raw-051 | 6689 | 3.8→6692.8 | 3.8→9285.6 | 0/8 vs 0/8 | 3/0/0 |
| d2-raw-a/test-d-raw-052 | 9218.7 | 3.3→9222 | 3.3→11894.8 | 0/8 vs 0/8 | 4/0/0 |
| d2-raw-a/test-d-raw-053 | 11690.9 | 3.8→11694.6 | 3.8→14288.1 | 0/8 vs 0/8 | 5/0/0 |
| d2-raw-a/test-d-raw-054 | 11701.1 | 6.4→11707.5 | 6.4→14318.8 | 0/8 vs 0/8 | 5/0/0 |
| d2-raw-a/test-d-raw-058 | 6691.7 | 4.8→6696.4 | 4.8→9291.3 | 0/9 vs 0/9 | 3/0/0 |
| d2-raw-a/test-d-raw-059 | 9191.3 | 3.7→9195 | 3.7→11793.3 | 0/9 vs 0/9 | 4/0/0 |
| d2-raw-b/test-d-raw-003 | 6701.7 | 10.7→6712.5 | 10.8→9414.5 | 0/1 vs 0/1 | 3/0/0 |
| d2-raw-b/test-d-raw-004 | 9203.4 | 4.7→9208.2 | 4.8→11810 | 0/1 vs 0/1 | 4/0/0 |
| d2-raw-b/test-d-raw-005 | 11705.3 | 6→11711.3 | 6→14308.3 | 0/1 vs 0/1 | 5/0/0 |
| d2-raw-b/test-d-raw-009 | 6709.2 | 3.7→6712.9 | 3.8→9287.6 | 0/2 vs 0/2 | 3/0/0 |
| d2-raw-b/test-d-raw-010 | 9214.1 | 3.3→9217.4 | 3.3→11830.3 | 0/2 vs 0/2 | 4/0/0 |
| d2-raw-b/test-d-raw-011 | 11700.6 | 7.9→11708.4 | 7.9→14313.4 | 0/2 vs 0/2 | 5/0/0 |
| d2-raw-b/test-d-raw-012 | 14016.5 | 3.6→14020.1 | 3.6→14250.7 | 0/2 vs 0/2 | 5/0/0 |
| d2-raw-b/test-d-raw-016 | 6690 | 5.2→6695.2 | 5.2→9304 | 0/3 vs 0/3 | 3/0/0 |
| d2-raw-b/test-d-raw-017 | 9219.9 | 3.5→9223.3 | 3.5→11816.6 | 0/3 vs 0/3 | 4/0/0 |
| d2-raw-b/test-d-raw-018 | 11696.3 | 7.5→11703.7 | 7.5→14352.6 | 0/3 vs 0/3 | 5/0/0 |
| d2-raw-b/test-d-raw-019 | 13677.4 | 6.2→13683.7 | 6.3→14317.2 | 0/3 vs 0/3 | 5/0/0 |
| d2-raw-b/test-d-raw-025 | 11728 | 5.4→11733.4 | 5.4→14338.4 | 0/4 vs 0/4 | 5/0/0 |
| d2-raw-b/test-d-raw-026 | 14214.3 | 5.6→14219.8 | 5.6→16820.5 | 0/4 vs 0/4 | 6/0/0 |
| d2-raw-b/test-d-raw-027 | 14231.4 | 4→14235.4 | 4→16843.6 | 0/4 vs 0/4 | 6/0/0 |
| d2-raw-b/test-d-raw-031 | 6678.1 | 3.2→6681.3 | 3.2→9295.1 | 0/5 vs 0/5 | 3/0/0 |
| d2-raw-b/test-d-raw-032 | 9197.1 | 3.6→9200.7 | 3.7→11804.9 | 0/5 vs 0/5 | 4/0/0 |
| d2-raw-b/test-d-raw-033 | 11749.5 | 4.7→11754.2 | 4.7→14285.8 | 0/5 vs 0/5 | 5/0/0 |
| d2-raw-b/test-d-raw-034 | 14218.6 | 4.1→14222.7 | 4.1→14522.8 | 0/5 vs 0/5 | 6/0/0 |
| d2-raw-b/test-d-raw-038 | 6684.2 | 11.3→6695.6 | 11.4→9302.8 | 0/6 vs 0/6 | 3/0/0 |
| d2-raw-b/test-d-raw-039 | 9174.9 | 3.1→9178.1 | 3.1→11787.5 | 0/6 vs 0/6 | 4/0/0 |
| d2-raw-b/test-d-raw-040 | 11716.2 | 3.9→11720.1 | 4.1→14307.8 | 0/6 vs 0/6 | 5/0/0 |
| d2-raw-b/test-d-raw-041 | 14061.5 | 6.5→14068 | 13.6→14228.7 | 0/6 vs 0/6 | 6/0/0 |
| d2-raw-b/test-d-raw-045 | 6709.4 | 3.7→6713.1 | 3.7→9331.1 | 0/7 vs 0/7 | 3/0/0 |
| d2-raw-b/test-d-raw-046 | 9196 | 3.8→9199.8 | 3.8→11811.7 | 0/7 vs 0/7 | 4/0/0 |
| d2-raw-b/test-d-raw-047 | 11723 | 8.3→11731.3 | 9.4→14476.9 | 0/7 vs 0/7 | 5/0/0 |
| d2-raw-b/test-d-raw-048 | 13794.5 | 7.4→13802 | 7.4→14320.7 | 0/7 vs 0/7 | 5/0/0 |
| d4-101-first-coalesced/test-d-raw-002 | 6691.8 | 6.9→6698.7 | 6.9→4294.2 | 0/1 vs 0/1 | 3/0/0 |
| d4-101-first-coalesced/test-d-raw-004 | 11701.6 | 15.8→11717.4 | 15.8→9325.6 | 0/1 vs 0/1 | 5/0/0 |
| d4-101-first-coalesced/test-d-raw-005 | 14223.1 | 8.1→14231.2 | 8.1→11819 | 0/1 vs 0/1 | 6/0/0 |
| d4-101-first-coalesced/test-d-raw-006 | 14236.4 | 4.9→14241.3 | 4.8→11820.4 | 0/1 vs 0/1 | 6/0/0 |
| d4-101-first-coalesced/test-d-raw-009 | 6696.2 | 4.1→6700.3 | 4.1→4264.1 | 0/2 vs 0/2 | 3/0/0 |
| d4-101-first-coalesced/test-d-raw-010 | 9201.3 | 9.1→9210.4 | 9.1→6796.6 | 0/2 vs 0/2 | 4/0/0 |
| d4-101-first-coalesced/test-d-raw-011 | 11695.1 | 6.8→11701.9 | 6.8→9283.9 | 0/2 vs 0/2 | 5/0/0 |
| d4-101-first-coalesced/test-d-raw-012 | 14227.4 | 4.2→14231.6 | 4.2→11808.8 | 0/2 vs 0/2 | 6/0/0 |
| d4-101-first-coalesced/test-d-raw-013 | 14271 | 3.3→14274.2 | 3.2→12540.5 | 0/2 vs 0/2 | 6/0/0 |
| d4-101-first-coalesced/test-d-raw-016 | 6714.9 | 3.1→6718 | 3.1→4462.5 | 0/3 vs 0/3 | 3/0/0 |
| d4-101-first-coalesced/test-d-raw-017 | 9199.1 | 3.9→9203 | 3.9→6785.5 | 0/3 vs 0/3 | 4/0/0 |
| d4-101-first-coalesced/test-d-raw-018 | 11708.6 | 7.8→11716.4 | 7.8→9320.3 | 0/3 vs 0/3 | 5/0/0 |
| d4-101-first-coalesced/test-d-raw-019 | 6838.4 | 5.7→6844.1 | 5.7→6766.8 | 0/3 vs 0/3 | 3/0/0 |
| d4-101-first-coalesced/test-d-raw-020 | 16728.3 | 3.9→16732.2 | 3.9→14339.3 | 0/3 vs 0/3 | 7/0/0 |

## Timelines representativos de tails 96 (hasta 3 más lentos por serie)

### d2-warm/warm-adopt-015 · 11714.2 ms

96: main, conexión 0, socket 1, msg_id 7693778138819882356; 101: main, conexión 0, socket 1, msg_id 7693778138821755436.

```text
   -7.9 ms  96  D_RPC_FLUSH packet=51
   -7.7 ms  96  D_RPC_MSG_ID_ASSIGNED
   -6.9 ms  101  D_RPC_FLUSH packet=52
     -1 ms  101  D_RPC_MSG_ID_ASSIGNED
    0.7 ms  96  D_RPC_WEBSOCKET_SEND packet=51
    0.8 ms  101  D_RPC_WEBSOCKET_SEND packet=52
 1506.2 ms  96  D_STATE_REQ_CONNECTION_SEND packet=53
 1508.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=53
 4022.3 ms  96  D_STATE_REQ_CONNECTION_SEND packet=54
 4022.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=54
 6526.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=55
 6527.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=55
 9030.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=56
 9031.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=56
11534.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=57
11534.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=57
  11715 ms  96  D_RPC_RESULT
12036.5 ms  101  D_RPC_RESULT
  15967 ms  96  D_STATE_INFO_RECEIVED status=108
15967.1 ms  96  D_MESSAGE_INFO_APPLIED status=108
  18469 ms  96  D_STATE_INFO_RECEIVED status=108
18469.1 ms  96  D_MESSAGE_INFO_APPLIED status=108
20964.2 ms  96  D_STATE_INFO_RECEIVED status=108
20964.2 ms  96  D_MESSAGE_INFO_APPLIED status=108
23481.7 ms  96  D_STATE_INFO_RECEIVED status=108
23481.9 ms  96  D_MESSAGE_INFO_APPLIED status=108
25983.3 ms  96  D_STATE_INFO_RECEIVED status=108
25983.4 ms  96  D_MESSAGE_INFO_APPLIED status=108
```

### d2-warm/warm-adopt-017 · 11691.7 ms

96: main, conexión 0, socket 1, msg_id 7693778264300854344; 101: main, conexión 0, socket 1, msg_id 7693778264300854352.

```text
   -7.5 ms  96  D_RPC_FLUSH packet=66
   -7.3 ms  96  D_RPC_MSG_ID_ASSIGNED
   -6.6 ms  101  D_RPC_FLUSH packet=67
   -6.4 ms  101  D_RPC_MSG_ID_ASSIGNED
   -5.3 ms  96  D_RPC_WEBSOCKET_SEND packet=66
   -5.3 ms  101  D_RPC_WEBSOCKET_SEND packet=67
 1507.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=68
 1508.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=68
 4008.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=69
 4009.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=69
 6515.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=70
 6516.2 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=70
 9016.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=71
 9017.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=71
11520.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=72
  11521 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=72
11686.4 ms  96  D_RPC_RESULT
11989.7 ms  101  D_RPC_RESULT
14371.1 ms  96  D_MESSAGE_INFO_APPLIED status=0
```

### d2-warm/warm-adopt-013 · 9183.4 ms

96: main, conexión 0, socket 1, msg_id 7693778032540497608; 101: main, conexión 0, socket 1, msg_id 7693778032555073652.

```text
    8.5 ms  96  D_RPC_FLUSH packet=38
    8.7 ms  96  D_RPC_MSG_ID_ASSIGNED
   14.1 ms  101  D_RPC_FLUSH packet=39
   14.3 ms  101  D_RPC_MSG_ID_ASSIGNED
   22.2 ms  96  D_RPC_WEBSOCKET_SEND packet=38
   22.9 ms  101  D_RPC_WEBSOCKET_SEND packet=39
 1505.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=40
 1506.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=40
 4011.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=41
 4012.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=41
   6523 ms  96  D_STATE_REQ_CONNECTION_SEND packet=42
 6523.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=42
 9037.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=43
   9038 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=43
 9205.6 ms  96  D_RPC_RESULT
   9543 ms  101  D_RPC_RESULT
13462.4 ms  96  D_STATE_INFO_RECEIVED status=108
13462.4 ms  96  D_MESSAGE_INFO_APPLIED status=108
15985.4 ms  96  D_STATE_INFO_RECEIVED status=108
15985.5 ms  96  D_MESSAGE_INFO_APPLIED status=108
18490.3 ms  96  D_STATE_INFO_RECEIVED status=108
18490.4 ms  96  D_MESSAGE_INFO_APPLIED status=108
21018.5 ms  96  D_STATE_INFO_RECEIVED status=108
21018.6 ms  96  D_MESSAGE_INFO_APPLIED status=108
```

### d2-warm-repeat/warm-adopt-017 · 11714.2 ms

96: main, conexión 0, socket 1, msg_id 7693783302129828368; 101: main, conexión 0, socket 1, msg_id 7693783302134005348.

```text
   -5.5 ms  96  D_RPC_FLUSH packet=67
     -5 ms  96  D_RPC_MSG_ID_ASSIGNED
   -4.2 ms  101  D_RPC_FLUSH packet=68
   -4.1 ms  101  D_RPC_MSG_ID_ASSIGNED
   -3.5 ms  96  D_RPC_WEBSOCKET_SEND packet=67
   -3.5 ms  101  D_RPC_WEBSOCKET_SEND packet=68
 1500.6 ms  96  D_STATE_REQ_CONNECTION_SEND packet=69
 1501.2 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=69
 4012.3 ms  96  D_STATE_REQ_CONNECTION_SEND packet=70
 4012.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=70
   6521 ms  96  D_STATE_REQ_CONNECTION_SEND packet=71
 6521.6 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=71
 9028.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=72
 9028.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=72
11537.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=73
11538.9 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=73
11710.7 ms  96  D_RPC_RESULT
12050.7 ms  101  D_RPC_RESULT
15877.7 ms  96  D_MESSAGE_INFO_APPLIED status=0
```

### d2-warm-repeat/warm-adopt-015 · 11708.3 ms

96: main, conexión 0, socket 1, msg_id 7693783176745273468; 101: main, conexión 0, socket 1, msg_id 7693783176746974028.

```text
    4.3 ms  96  D_RPC_FLUSH packet=52
    4.5 ms  96  D_RPC_MSG_ID_ASSIGNED
      6 ms  101  D_RPC_FLUSH packet=53
    6.5 ms  101  D_RPC_MSG_ID_ASSIGNED
      9 ms  96  D_RPC_WEBSOCKET_SEND packet=52
      9 ms  101  D_RPC_WEBSOCKET_SEND packet=53
 1511.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=54
 1511.6 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=54
 4010.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=55
 4010.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=55
 6524.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=56
 6525.2 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=56
 9035.6 ms  96  D_STATE_REQ_CONNECTION_SEND packet=57
   9036 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=57
  11541 ms  96  D_STATE_REQ_CONNECTION_SEND packet=58
11541.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=58
11717.3 ms  96  D_RPC_RESULT
12002.8 ms  101  D_RPC_RESULT
15925.8 ms  96  D_STATE_INFO_RECEIVED status=108
15925.9 ms  96  D_MESSAGE_INFO_APPLIED status=108
18431.2 ms  96  D_STATE_INFO_RECEIVED status=108
18431.3 ms  96  D_MESSAGE_INFO_APPLIED status=108
20942.8 ms  96  D_STATE_INFO_RECEIVED status=108
20942.8 ms  96  D_MESSAGE_INFO_APPLIED status=108
23454.7 ms  96  D_STATE_INFO_RECEIVED status=108
23454.9 ms  96  D_MESSAGE_INFO_APPLIED status=108
25955.7 ms  96  D_STATE_INFO_RECEIVED status=108
25955.9 ms  96  D_MESSAGE_INFO_APPLIED status=108
```

### d2-warm-repeat/warm-adopt-013 · 9205.1 ms

96: main, conexión 0, socket 1, msg_id 7693783070425800868; 101: main, conexión 0, socket 1, msg_id 7693783070428102076.

```text
  -17.8 ms  96  D_RPC_FLUSH packet=39
  -17.6 ms  96  D_RPC_MSG_ID_ASSIGNED
  -17.2 ms  101  D_RPC_FLUSH packet=40
    -17 ms  101  D_RPC_MSG_ID_ASSIGNED
  -16.6 ms  96  D_RPC_WEBSOCKET_SEND packet=39
  -16.6 ms  101  D_RPC_WEBSOCKET_SEND packet=40
 1492.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=41
 1492.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=41
 3996.2 ms  96  D_STATE_REQ_CONNECTION_SEND packet=42
 3996.6 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=42
 6500.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=43
 6502.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=43
 9013.2 ms  96  D_STATE_REQ_CONNECTION_SEND packet=44
 9020.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=44
 9188.5 ms  96  D_RPC_RESULT
 9498.4 ms  101  D_RPC_RESULT
13404.8 ms  96  D_STATE_INFO_RECEIVED status=108
13405.1 ms  96  D_MESSAGE_INFO_APPLIED status=108
16001.2 ms  96  D_STATE_INFO_RECEIVED status=108
16001.4 ms  96  D_MESSAGE_INFO_APPLIED status=108
18419.6 ms  96  D_STATE_INFO_RECEIVED status=108
18419.7 ms  96  D_MESSAGE_INFO_APPLIED status=108
20935.2 ms  96  D_STATE_INFO_RECEIVED status=108
20935.3 ms  96  D_MESSAGE_INFO_APPLIED status=108
```

### d2-raw-a/test-d-raw-040 · 14204.4 ms

96: main, conexión 0, socket 6, msg_id 7693746339366301964; 101: main, conexión 0, socket 6, msg_id 7693746339368566324.

```text
    2.2 ms  96  D_RPC_FLUSH packet=258
    2.4 ms  96  D_RPC_MSG_ID_ASSIGNED
      3 ms  101  D_RPC_FLUSH packet=259
    3.2 ms  101  D_RPC_MSG_ID_ASSIGNED
    3.7 ms  96  D_RPC_WEBSOCKET_SEND packet=258
    3.7 ms  101  D_RPC_WEBSOCKET_SEND packet=259
 1504.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=260
 1504.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=260
 1504.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=260
 1504.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=260
 4008.5 ms  96  D_STATE_REQ_CONNECTION_SEND packet=261
 4008.5 ms  101  D_STATE_REQ_CONNECTION_SEND packet=261
 4009.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=261
 4009.5 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=261
 6516.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=262
 6516.8 ms  101  D_STATE_REQ_CONNECTION_SEND packet=262
 6517.2 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=262
 6517.2 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=262
 9026.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=263
 9026.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=263
 9026.9 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=263
 9026.9 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=263
11527.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=264
11527.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=264
11528.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=264
11528.3 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=264
14034.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=265
14034.7 ms  101  D_STATE_REQ_CONNECTION_SEND packet=265
14035.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=265
14035.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=265
14208.1 ms  96  D_RPC_RESULT
16119.7 ms  101  D_RPC_RESULT
```

### d2-raw-a/test-d-raw-019 · 12228.3 ms

96: main, conexión 0, socket 3, msg_id 7693745454611526404; 101: main, conexión 0, socket 3, msg_id 7693745454611526412.

```text
    1.9 ms  96  D_RPC_FLUSH packet=120
    2.2 ms  96  D_RPC_MSG_ID_ASSIGNED
    2.9 ms  101  D_RPC_FLUSH packet=121
    3.2 ms  101  D_RPC_MSG_ID_ASSIGNED
    3.7 ms  96  D_RPC_WEBSOCKET_SEND packet=120
    3.7 ms  101  D_RPC_WEBSOCKET_SEND packet=121
 1515.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=122
 1515.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=122
 1518.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=122
 1518.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=122
   4017 ms  96  D_STATE_REQ_CONNECTION_SEND packet=123
   4017 ms  101  D_STATE_REQ_CONNECTION_SEND packet=123
 4021.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=123
 4021.5 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=123
 6517.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=124
 6517.8 ms  101  D_STATE_REQ_CONNECTION_SEND packet=124
 6518.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=124
 6518.3 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=124
 9024.5 ms  96  D_STATE_REQ_CONNECTION_SEND packet=125
 9024.5 ms  101  D_STATE_REQ_CONNECTION_SEND packet=125
 9025.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=125
 9025.7 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=125
11526.5 ms  96  D_STATE_REQ_CONNECTION_SEND packet=126
11526.5 ms  101  D_STATE_REQ_CONNECTION_SEND packet=126
  11527 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=126
  11527 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=126
  12232 ms  96  D_RPC_RESULT
14033.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=127
14034.3 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=127
14366.8 ms  101  D_RPC_RESULT
```

### d2-raw-a/test-d-raw-039 · 11730.7 ms

96: main, conexión 0, socket 6, msg_id 7693746275617281076; 101: main, conexión 0, socket 6, msg_id 7693746275619180756.

```text
    2.6 ms  96  D_RPC_FLUSH packet=250
    2.8 ms  96  D_RPC_MSG_ID_ASSIGNED
    3.3 ms  101  D_RPC_FLUSH packet=251
    3.4 ms  101  D_RPC_MSG_ID_ASSIGNED
    3.9 ms  96  D_RPC_WEBSOCKET_SEND packet=250
    3.9 ms  101  D_RPC_WEBSOCKET_SEND packet=251
 1507.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=252
 1507.8 ms  101  D_STATE_REQ_CONNECTION_SEND packet=252
 1509.2 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=252
 1509.2 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=252
 4022.2 ms  96  D_STATE_REQ_CONNECTION_SEND packet=253
 4022.2 ms  101  D_STATE_REQ_CONNECTION_SEND packet=253
 4023.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=253
 4023.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=253
 6522.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=254
 6522.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=254
 6522.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=254
 6522.5 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=254
   9030 ms  96  D_STATE_REQ_CONNECTION_SEND packet=255
   9030 ms  101  D_STATE_REQ_CONNECTION_SEND packet=255
 9031.6 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=255
 9031.6 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=255
11532.5 ms  96  D_STATE_REQ_CONNECTION_SEND packet=256
11532.5 ms  101  D_STATE_REQ_CONNECTION_SEND packet=256
11532.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=256
11532.8 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=256
11734.6 ms  96  D_RPC_RESULT
  14044 ms  101  D_STATE_REQ_CONNECTION_SEND packet=257
14044.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=257
14369.8 ms  101  D_RPC_RESULT
```

### d2-raw-b/test-d-raw-027 · 14231.4 ms

96: main, conexión 0, socket 4, msg_id 7693776300483633636; 101: main, conexión 0, socket 4, msg_id 7693776300485595852.

```text
    2.6 ms  96  D_RPC_FLUSH packet=177
    2.7 ms  96  D_RPC_MSG_ID_ASSIGNED
    3.3 ms  101  D_RPC_FLUSH packet=178
    3.4 ms  101  D_RPC_MSG_ID_ASSIGNED
      4 ms  96  D_RPC_WEBSOCKET_SEND packet=177
      4 ms  101  D_RPC_WEBSOCKET_SEND packet=178
 1513.3 ms  96  D_STATE_REQ_CONNECTION_SEND packet=179
 1513.3 ms  101  D_STATE_REQ_CONNECTION_SEND packet=179
   1514 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=179
   1514 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=179
 4038.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=180
 4038.7 ms  101  D_STATE_REQ_CONNECTION_SEND packet=180
 4041.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=180
 4041.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=180
 6536.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=181
 6536.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=181
 6536.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=181
 6536.5 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=181
 9043.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=182
 9043.7 ms  101  D_STATE_REQ_CONNECTION_SEND packet=182
 9044.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=182
 9044.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=182
11546.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=183
11546.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=183
11548.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=183
11548.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=183
14056.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=184
14056.8 ms  101  D_STATE_REQ_CONNECTION_SEND packet=184
14057.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=184
14057.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=184
14235.4 ms  96  D_RPC_RESULT
16567.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=185
16568.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=185
16843.6 ms  101  D_RPC_RESULT
```

### d2-raw-b/test-d-raw-034 · 14218.6 ms

96: main, conexión 0, socket 5, msg_id 7693776592151460236; 101: main, conexión 0, socket 5, msg_id 7693776592153325260.

```text
      3 ms  96  D_RPC_FLUSH packet=222
    3.1 ms  96  D_RPC_MSG_ID_ASSIGNED
    3.6 ms  101  D_RPC_FLUSH packet=223
    3.7 ms  101  D_RPC_MSG_ID_ASSIGNED
    4.1 ms  96  D_RPC_WEBSOCKET_SEND packet=222
    4.1 ms  101  D_RPC_WEBSOCKET_SEND packet=223
 1516.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=224
 1516.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=224
 1517.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=224
 1517.3 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=224
 4027.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=225
 4027.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=225
 4028.2 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=225
 4028.2 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=225
   6534 ms  96  D_STATE_REQ_CONNECTION_SEND packet=226
   6534 ms  101  D_STATE_REQ_CONNECTION_SEND packet=226
 6535.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=226
 6535.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=226
 9040.3 ms  96  D_STATE_REQ_CONNECTION_SEND packet=227
 9040.3 ms  101  D_STATE_REQ_CONNECTION_SEND packet=227
 9040.6 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=227
 9040.6 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=227
11544.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=228
11544.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=228
11544.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=228
11544.8 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=228
14052.3 ms  96  D_STATE_REQ_CONNECTION_SEND packet=229
14052.3 ms  101  D_STATE_REQ_CONNECTION_SEND packet=229
14052.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=229
14052.8 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=229
14222.7 ms  96  D_RPC_RESULT
14522.8 ms  101  D_RPC_RESULT
```

### d2-raw-b/test-d-raw-026 · 14214.3 ms

96: main, conexión 0, socket 4, msg_id 7693776227211163208; 101: main, conexión 0, socket 4, msg_id 7693776227211163216.

```text
    4.4 ms  96  D_RPC_FLUSH packet=168
    4.6 ms  96  D_RPC_MSG_ID_ASSIGNED
      5 ms  101  D_RPC_FLUSH packet=169
    5.1 ms  101  D_RPC_MSG_ID_ASSIGNED
    5.6 ms  96  D_RPC_WEBSOCKET_SEND packet=168
    5.6 ms  101  D_RPC_WEBSOCKET_SEND packet=169
 1506.6 ms  96  D_STATE_REQ_CONNECTION_SEND packet=170
 1506.6 ms  101  D_STATE_REQ_CONNECTION_SEND packet=170
 1506.9 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=170
 1506.9 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=170
 4013.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=171
 4013.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=171
 4014.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=171
 4014.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=171
 6525.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=172
 6525.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=172
 6525.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=172
 6525.8 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=172
 9029.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=173
 9029.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=173
 9029.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=173
 9029.8 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=173
11544.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=174
11544.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=174
11544.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=174
11544.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=174
14058.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=175
14058.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=175
14058.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=175
14058.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=175
14219.8 ms  96  D_RPC_RESULT
16568.3 ms  101  D_STATE_REQ_CONNECTION_SEND packet=176
16568.6 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=176
16820.5 ms  101  D_RPC_RESULT
```

### d4-101-first-coalesced/test-d-raw-020 · 16728.3 ms

96: main, conexión 0, socket 3, msg_id 7693782527506759344; 101: main, conexión 0, socket 3, msg_id 7693782527506437860.

```text
    2.6 ms  101  D_RPC_FLUSH packet=125
    2.8 ms  101  D_RPC_MSG_ID_ASSIGNED
    3.3 ms  96  D_RPC_FLUSH packet=126
    3.4 ms  96  D_RPC_MSG_ID_ASSIGNED
    3.9 ms  96  D_RPC_WEBSOCKET_SEND packet=126
    3.9 ms  101  D_RPC_WEBSOCKET_SEND packet=125
 1515.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=127
 1515.8 ms  101  D_STATE_REQ_CONNECTION_SEND packet=127
 1516.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=127
 1516.3 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=127
 4016.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=128
 4016.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=128
   4017 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=128
   4017 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=128
 6529.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=129
 6529.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=129
 6529.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=129
 6529.5 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=129
 9040.3 ms  96  D_STATE_REQ_CONNECTION_SEND packet=130
 9040.3 ms  101  D_STATE_REQ_CONNECTION_SEND packet=130
 9040.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=130
 9040.8 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=130
11550.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=131
11550.8 ms  101  D_STATE_REQ_CONNECTION_SEND packet=131
11551.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=131
11551.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=131
14068.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=132
14068.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=132
14068.9 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=132
14068.9 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=132
14339.3 ms  101  D_RPC_RESULT
16566.2 ms  96  D_STATE_REQ_CONNECTION_SEND packet=133
16568.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=133
16732.2 ms  96  D_RPC_RESULT
```

### d4-101-first-coalesced/test-d-raw-013 · 14271 ms

96: main, conexión 0, socket 2, msg_id 7693782256967904404; 101: main, conexión 0, socket 2, msg_id 7693782256967879116.

```text
    2.1 ms  101  D_RPC_FLUSH packet=79
    2.2 ms  101  D_RPC_MSG_ID_ASSIGNED
    2.7 ms  96  D_RPC_FLUSH packet=80
    2.8 ms  96  D_RPC_MSG_ID_ASSIGNED
    3.2 ms  101  D_RPC_WEBSOCKET_SEND packet=79
    3.3 ms  96  D_RPC_WEBSOCKET_SEND packet=80
 1505.8 ms  96  D_STATE_REQ_CONNECTION_SEND packet=81
 1505.8 ms  101  D_STATE_REQ_CONNECTION_SEND packet=81
 1507.6 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=81
 1507.6 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=81
 4045.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=82
 4045.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=82
 4045.8 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=82
 4045.8 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=82
 6558.6 ms  96  D_STATE_REQ_CONNECTION_SEND packet=83
 6558.6 ms  101  D_STATE_REQ_CONNECTION_SEND packet=83
   6559 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=83
   6559 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=83
 9064.5 ms  96  D_STATE_REQ_CONNECTION_SEND packet=84
 9064.5 ms  101  D_STATE_REQ_CONNECTION_SEND packet=84
 9066.1 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=84
 9066.1 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=84
11577.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=85
11577.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=85
11578.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=85
11578.7 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=85
12540.5 ms  101  D_RPC_RESULT
14091.6 ms  96  D_STATE_REQ_CONNECTION_SEND packet=86
14092.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=86
14274.2 ms  96  D_RPC_RESULT
```

### d4-101-first-coalesced/test-d-raw-006 · 14236.4 ms

96: main, conexión 0, socket 1, msg_id 7693781966223036412; 101: main, conexión 0, socket 1, msg_id 7693781966222919384.

```text
    3.3 ms  101  D_RPC_FLUSH packet=34
    3.6 ms  101  D_RPC_MSG_ID_ASSIGNED
    4.1 ms  96  D_RPC_FLUSH packet=35
    4.3 ms  96  D_RPC_MSG_ID_ASSIGNED
    4.8 ms  101  D_RPC_WEBSOCKET_SEND packet=34
    4.9 ms  96  D_RPC_WEBSOCKET_SEND packet=35
 1515.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=36
 1515.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=36
 1515.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=36
 1515.7 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=36
 4022.7 ms  96  D_STATE_REQ_CONNECTION_SEND packet=37
 4022.7 ms  101  D_STATE_REQ_CONNECTION_SEND packet=37
 4024.4 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=37
 4024.4 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=37
 6538.1 ms  96  D_STATE_REQ_CONNECTION_SEND packet=38
 6538.1 ms  101  D_STATE_REQ_CONNECTION_SEND packet=38
 6538.7 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=38
 6538.7 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=38
 9050.4 ms  96  D_STATE_REQ_CONNECTION_SEND packet=39
 9050.4 ms  101  D_STATE_REQ_CONNECTION_SEND packet=39
 9051.5 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=39
 9051.5 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=39
11553.9 ms  96  D_STATE_REQ_CONNECTION_SEND packet=40
11553.9 ms  101  D_STATE_REQ_CONNECTION_SEND packet=40
11554.3 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=40
11554.3 ms  101  D_STATE_REQ_WEBSOCKET_SEND packet=40
11820.4 ms  101  D_RPC_RESULT
  14069 ms  96  D_STATE_REQ_CONNECTION_SEND packet=41
14069.6 ms  96  D_STATE_REQ_WEBSOCKET_SEND packet=41
14241.3 ms  96  D_RPC_RESULT
```
