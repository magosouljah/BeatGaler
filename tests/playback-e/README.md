# Test E · límite físico de escritura MTProto/WebSocket

Test aislado de la app y de la UI para la cuenta Stage1 `03`, mensaje `96` (`Stage1 Playback v2 03.mp3`) y competidor `101`. Usa `TelegramClient.downloadChunk`, la sesión temporal, mtcute y el worker reales. Prepara sesión, peer y descriptores fuera de `START`; no mide reproducción. No modifica producción ni `node_modules` en disco.

## Camino inspeccionado (E0)

- `@mtcute/core/network/session-connection.js:1228,1558–1559`: `_doFlush()` serializa/cifra un paquete MTProto y llama a `send(enc)` sin esperar la respuesta RPC.
- `@mtcute/core/network/persistent-connection.js:83–96,193–200`: crea **un** `FramedWriter` por conexión y le pasa los paquetes cifrados.
- `@mtcute/web/websocket.js:33–40`: WebSocket con `ObfuscatedPacketCodec(IntermediatePacketCodec)`; no usa un segundo socket para los dos RPC de la condición principal.
- `@mtcute/core/network/transports/intermediate.js:26–28`: cada unidad tiene un prefijo de longitud little-endian de 4 bytes antes del cifrado.
- `@mtcute/core/network/transports/obfuscated.js:58–61`: cifra cada unidad con el estado CTR de la conexión.
- `@fuman/io/codec/writer.js:17–26`: `FramedWriter` reutiliza un `Bytes` privado; `write()` espera `encode()` **antes** de llamar `result()` y `reset()`. Dos invocaciones solapadas pueden haber escrito ambas en el mismo buffer antes de que la primera lea el resultado.
- `@fuman/net/websocket.js:82–85`: la escritura física del adaptador llama a `socket.send(bytes)` una vez por entrega del writer. La capa WebSocket recibe un buffer agregado si el writer ya lo formó.

Los probes de Test E son exclusivamente del harness: `tests/playback-d/instrument.mjs` identifica RPC/paquete/socket/write y opcionalmente registra unidades cifradas; `--test-e-writer fresh` sustituye sólo en memoria el writer de la conexión de prueba por uno nuevo **por paquete**, preservando el codec CTR, la conexión, el socket, las dos promesas concurrentes y el tamaño de descarga. No espera `rpc_result` entre paquetes. El control cruzado observa también eventos `message` entrantes del WebSocket. `tests/playback-direct/worker.mjs` transfiere cuatro muestras cifradas por proceso al directorio local `tmp/playback-e/.../buffers/` ignorado por Git. No se guardan claves, cookies ni contenido descifrado.

## Ejecución

`writer-race.mjs` compara una copia mínima del writer anterior con el writer instalado y sigue siendo ejecutable después del parche. Las series E1/E2 y sus comandos siguientes son el protocolo histórico anterior al parche; ejecutarlos ahora sobre este checkout no reconstruye E1, porque `shared` ya usa el writer corregido. Los resultados históricos se conservan en `RESULTS.md`.

Requiere `.env.stage1`, PostgreSQL y Cloud local preparados como en Test D. Ejecutar las dos fases **secuencialmente**, sin otros benchmarks que compitan por las conexiones:

```powershell
node tests/playback-e/writer-race.mjs
node tests/playback-e/run-suite.mjs --phase main
node tests/playback-e/run-suite.mjs --phase controls
node tests/playback-e/run-suite.mjs --phase supplement
node tests/playback-e/rebuild-report.mjs --collect
node tests/playback-e/rebuild-report.mjs
```

La fase principal pide al menos 200 pares físicos baseline (250 intentos para compensar retries) y 500 con buffer independiente, en procesos de 50 runs para evitar expiración de la auth temporal. La fase de controles incluye microtask, siguiente macrotask, 1 ms, un control cruzado que alterna writers dentro de la **misma sesión/socket**, orden inverso, 1/3/4 solicitudes, pequeño+pequeño y una ráfaga de siete. El primer bloque cruzado conservó 62 runs completos antes de que expirase la auth temporal en el run 63; el bloque `e2-cross-over-b` lo completa en una nueva auth y el reporte nunca empareja runs de ambas sesiones. La fase supplement hace fresh→shared→fresh y dos controles de reconnect fuera de START; `e2-reset-immediate` renueva el socket justo después de un run fresh todavía lento, conservando la sesión. Así se distingue la prevención de nuevos agrupamientos de la recuperación de una conexión ya afectada. Cada caso valida si obtuvo realmente los RPC físicos concurrentes y el número de escrituras previsto; un run lógico fallido no se cuenta como evidencia válida. Un directorio completo se reutiliza; el bloque cruzado parcial se conserva sólo porque el error de auth quedó identificado y los runs previos fueron completos.

`--collect` comprime las trazas estructuradas y escribe `traces/manifest.json` con SHA-256 de la versión cruda y comprimida. Sin `--collect`, el reconstruidor comprueba esos hashes y genera `RESULTS.md` y `analysis.json` desde las trazas locales, sin necesitar Cloud ni las sesiones. Git conserva sólo el resumen revisado `RESULTS.md`; `analysis.json`, las trazas y los buffers `.bin` permanecen locales e ignorados. Los hashes y límites de cada muestra están en las trazas locales.

Las duraciones `WebSocket.send → rpc_result` son observaciones del cliente. No separan procesamiento remoto, ruta de red y retransmisiones internas. Una llamada a `WebSocket.send()` identifica un mensaje lógico de API, pero esta instrumentación no observa fragmentación en frames WebSocket ni segmentos TCP.
