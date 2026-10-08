# Harness directo de playback

Ejecuta el **worker de producción** en `node:worker_threads`, con `@mtcute/web`, WebSocket, criptografía WASM y autorizaciones temporales reales. No inicia navegador, React, Vite, INDEX ni la biblioteca completa. No cambia archivos de producción, tamaños de prefijo, cachés, lanes ni retries del worker.

Destino predeterminado: cuenta Stage1 `03`, mensaje `96`, `Stage1 Playback v2 03.mp3`. Verifica el nombre devuelto por Telegram antes de aceptar la muestra.

## Ejecutar

Requiere las dependencias instaladas del repo, Node 22, FFmpeg en PATH, las credenciales **existentes** de `.env.stage1` y Cloud/PostgreSQL disponibles. No crea cuentas, sube archivos ni modifica beats. Login, sesiones temporales, heartbeat y cierre usan el control plane normal. No ejecutar simultáneamente dos series si se quiere medir aislamiento.

Si Cloud no está iniciado, en otra terminal desde `E:/777/app/beatvault/cloud-server`:

```powershell
node --env-file=.env server.js
```

Desde la raíz del repo:

```powershell
node scripts/run-playback-direct.mjs --runs 20
node scripts/run-playback-direct.mjs --runs 12 --mode cold
node scripts/run-playback-direct.mjs --runs 6 --mode warm
node scripts/run-playback-direct.mjs --runs 6 --mode duplicate
```

- `repeat`: mismo worker/sesión, preserva sus cachés naturales. El caché de rangos del worker se consume al leerlo; no equivale al caché de replay completo de la UI.
- `cold`: nueva autorización temporal, worker y cachés locales por intento. No vacía cachés de Telegram. Separa preparación de sesión de START→PCM.
- `warm`: lanza un batch WARM real para el mismo mensaje y, 10 ms después, foreground. Es una prueba de solapamiento en el worker; no reproduce la adopción de la promesa por `webPlaybackSource`.
- `duplicate`: dos consumidores foreground simultáneos del mismo mensaje. Distingue solicitudes lógicas de descargas físicas concurrentes.
- `--route stream` (default): stream real desde offset 0, como el camino MSE sin prefijo de la app. `--route prefetch`: petición foreground del prefijo fijo de producción.
- `--account`, `--message`, `--filename`, `--ffmpeg`, `--out`: overrides explícitos; ver `--help`.

Salida por defecto: `tmp/playback-harness/direct-<fecha>-<modo>/`. Un directorio con trazas existentes no se sobrescribe.

## Qué mide

`START → foco/request → resolución media → getMessages → espera de lane → downloadChunk/upload.getFile → WebSocket → rango en worker → entrega al consumidor → frames MPEG → PCM de FFmpeg`.

`FIRST_USEFUL_RANGE` exige al menos dos frames MPEG completos según `measureMp3PlayablePrefix` de producción. `DECODED_PCM` requiere bytes PCM reales de FFmpeg. FFmpeg recibe los bytes y EOF; su creación, cierre de entrada y decodificación forman parte del tiempo del consumidor. **No son MSE, evento playing, salida audible ni avance de currentTime**: esas columnas son null.

La sesión/peer se preparan antes de START; `session_setup_ms` y los eventos `SESSION_*`/`CONTROL_*` conservan ese costo por separado. El adaptador HTTP reproduce la secuencia reserve → prepareWebTempAuth → bind → initialize → activate → verify, con el mismo máximo de dos intentos ante `invalid nonce hash` que `bindTemporarySession`. No carga AccountGate ni WebTransportController.

## Pipeline real de la app y archivos relevantes

1. `src/features/playback/usePlaybackController.ts`: `handlePlay`, intent, `platform.media.preparePlayback`, llamada a audio.
2. `src/platform/webAdapter.ts`, `src/features/playback/webPlaybackIntent.ts`: ruta del beat e identidad del intento.
3. `src/features/playback/webPlaybackSource.ts`: cola WARM, promoción/adopción, caché RAM, preparación MSE/Blob, stream y append; `webVisiblePlaybackPrefetch.ts` y `webStartupPlaybackCoordinator.ts` generan el trabajo especulativo.
4. `src/features/cloud/webGalerCloudTransport.ts`, `webTransportController.ts`, `webTransportSession.ts`, `webTempAuth.ts`: prioridad, sesión temporal, conexión y peer. La sesión se reutiliza si ya existe.
5. `src/features/cloud/webTransportWorkerClient.ts`, `webTransportWorkerProtocol.ts`: cruce main↔worker, entrega y ACK del stream.
6. `src/features/cloud/webTransport.worker.ts`: foco/scheduler, caché y deduplicación de media, `getMessages`, lanes, rangos compartidos, `downloadChunk`/`downloadAsIterable`.
7. `@mtcute/core` (`highlevel/methods/files`, `network/session-connection.js`) y `@mtcute/web/websocket.js`: resolución `channels.getMessages`, `upload.getFile`, sesión, cola RPC, retransmisiones y transporte.
8. `src/hooks/useAudio.ts`: `audio.src`, `play()`, canplay/playing/timeupdate; el source recibe el progreso y evalúa estabilidad. Un evento playing con currentTime=0 no demuestra progreso sostenido.

El harness compila/importa realmente los módulos de **worker, protocolo, mp3PlayablePrefix, playTrace, traceClock, webTempAuth, playbackGetFileTrace y guardas mtcute**. Los módulos UI/main/controller se inspeccionaron, pero no se ejecutan. El adaptador Worker/HTTP y FFmpeg sustituyen sólo esos extremos del test.

## Observabilidad existente y añadida

Ya existían `APP_*`, `SOURCE_*`, `MSE_*`, `AUDIO_*`, `WORKER_MEDIA_GET_MESSAGES_{BEGIN,DONE,ERROR}`, resolución hit/miss/join, lanes, rangos shared/promoted/cache, `WORKER_PREFIX_DOWNLOAD_*` y trazas de sesión. `playbackGetFileTrace.ts` ya observaba core.call, conexión/cola RPC, envío real de WebSocket, reintentos, recepción del frame correlacionado y resolución de getFile. No se atribuye su implementación a este trabajo.

El harness añade, exclusivamente fuera de producción:

- `run_id`, `intent_id`, timestamps comparables y JSONL para todas las observaciones, incluyendo las que no traían intent_id.
- START, solicitudes explícitas, FIRST_BYTES, FIRST_USEFUL_RANGE, CONSUMER/DECODED_PCM y resultado por run.
- Prueba de identidad del archivo sobre el resultado real de `getMessages`.
- `MTCUTE_CORE_CALL_*` y `MTCUTE_CONNECTION_RPC_*`, con `lookup_id`/`rpc_id`, errores RPC seguros y bytes. Permiten separar trabajo local antes de getMessages RPC de la espera de su conexión.
- Preparación de sesión, intentos/errores de nonce, tiempo HTTP, identidad de transporte y etiqueta hash de sesión. Las credenciales y cuerpos RPC/audio no se escriben a las trazas.
- Conteos de consumidores, joins, cachés, descargas, reenvíos y duplicados físicos concurrentes.

## Leer los resultados

- `report.md`: tabla **por run**, con etapas disjuntas que suman START→PCM.
- `runs.csv`: tabla completa, con subdivisiones de red, cachés, bytes y errores.
- `summary.json`: resultados, estado, identidad de código/hashes y límites del protocolo.
- `trace.jsonl`: evidencia original; cada evento conserva run/intent/request cuando corresponde.

`dispatch + media_resolve + range_wait + range_to_frames + consumer = total_to_pcm` (salvo redondeo). `get_messages_ms` está dentro de media; `download_ms` es trabajo de descarga de todos los consumidores del run. En WARM/duplicate puede solaparse con el camino principal e incluso acabar después del PCM principal: **no sumar estas subdivisiones al total**.

`socket_to_first_response_ms` es envío WebSocket → primer evento WebSocket asociado al frame de respuesta. Incluye red y servidor; no separa procesamiento de Telegram. `response_transfer_ms=0` significa que la respuesta se observó en un solo evento WebSocket, no transferencia física instantánea. `get_messages_connection_ms` incluye la espera dentro de mtcute; no se etiqueta como tiempo puro en Telegram. Retransmisiones quedan en el JSONL; el desglose fino de getFile corresponde al primer RPC observado. La continuación `downloadAsIterable` deja eventos core/RPC, pero no tiene la misma atribución de frame que el primer rango. Para el archivo objetivo completo de 17 136 bytes no hace falta continuación.

No hay carga de INDEX, otros beats, otras cuentas ni implementación de MSE en esta prueba. Un resultado rápido aquí **no descarta** demoras en esos contextos ni permite atribuir retrospectivamente los tails históricos. El checkout ya tenía cambios locales antes de crear el harness; los hashes identifican lo que se ejecutó.

Recalcular tablas sin red y sin alterar JSONL:

```powershell
node tests/playback-direct/rebuild-report.mjs tmp/playback-harness/<directorio>
node --test tests/playback-direct/report.test.mjs
```

El test sintético de 10.4 s verifica la contabilidad de 8.7 s en una frontera: **no es una reproducción real del tail**.
