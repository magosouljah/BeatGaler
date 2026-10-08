# Test D · conexión MTProto, WARM y `upload.getFile`

Test D mide exclusivamente el tramo de Telegram/mtcute para la cuenta `03`, mensaje 96 (`Stage1 Playback v2 03.mp3`, 17 136 bytes) y competidor 101. Reutiliza el harness A y su worker de producción. Los probes viven en `tests/playback-d/instrument.mjs` y solo se importan en el worker del harness. No hay cambios de comportamiento de producción, navegador, React ni audio. Requiere `.env.stage1`, Cloud/PostgreSQL y FFmpeg como Test A.

Hay dos protocolos deliberadamente separados:

1. **WARM original**: `warm-adopt` usa el batch `[96,101]`, el foco 96 y el timing de 10 ms de Test C. Confirma qué ocurre en la ruta problemática de la app. El foco puede posponer el RPC de 101 hasta después del resultado de 96; por eso WARM simultáneo no implica RPC físico simultáneo. La variante D3 cambia solo la selección de pool del `upload.getFile` de 101 a `kind:'download'` dentro del worker de test; 96 continúa en `main`, tal como hace el código real. No se cambian los archivos de mtcute.
2. **Par raw físico**: después de preparar sesión, peer y descriptores con el worker de producción, `test_d_raw_pair` llama dos veces al `TelegramClient.downloadChunk` real con `offset=0, limit=65536` sin caché WARM. Ambos RPC se esperan antes de cerrar cada run. D1 llama solo al 96; D2 los llama en `main` del mismo cliente; D3 enruta solo 101 a `download`. En D3 se prepara ese pool con `help.getConfig` antes de `START`, fuera de la muestra. Para D4 se controla el orden y desplazamiento de las dos llamadas raw. La preparación inicial descarga ambos archivos fuera de START; los runs raw siempre fuerzan RPC físico y no sirven para medir misses de metadatos ni WARM.

Los dos modos conservan la misma cuenta, DC y autenticación lógica. El probe registra pool, `connection_uid`, `connection_probe_id`, `socket_id`, hash truncado de sesión MTProto (`session_tag`), `msg_id`, enqueue, packet/flush, encode, `WebSocket.send`, ACK del servidor si llega, state requests/responses, requeue y `rpc_result`. No guarda auth key, file location, access hash, contenido ni bytes descargados. Un `D_RPC_FLUSH` **no** se cuenta como envío físico: la distribución se construye solo con `D_RPC_WEBSOCKET_SEND` emparejado con `D_RPC_RESULT` por `msg_id`. En mtcute, ambos `downloadChunk` usan `main` por defecto: la etiqueta `download` del scheduler de BeatGaler no selecciona automáticamente el pool `download` de mtcute.

`@fuman/io` puede codificar dos paquetes MTProto en el mismo buffer de su `FramedWriter` antes de una sola escritura física. El probe registra entonces un mismo `ws_send_id` para ambos paquetes. Esto es distinto de compartir un contenedor MTProto: `packet_id` y `container_id` permiten separar ambos conceptos.

Ejecutar las series **secuencialmente**, con directorios nuevos, para no hacer competir conexiones de dos experimentos. El límite del runner es 100 runs por invocación; repetir las series si hacen falta más RPC físicos:

```powershell
node scripts/run-playback-direct.mjs --runs 100 --mode test-d-raw --test-d-mode observe --test-d-include-101 false --out tmp/playback-d/d1-final
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-d-mode observe --out tmp/playback-d/d2-warm-final
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-d-mode observe --test-d-route-101 download --out tmp/playback-d/d3-warm-final
node scripts/run-playback-direct.mjs --runs 100 --mode test-d-raw --test-d-mode observe --out tmp/playback-d/d2-raw-final
node scripts/run-playback-direct.mjs --runs 100 --mode test-d-raw --test-d-mode observe --test-d-route-101 download --out tmp/playback-d/d3-raw-final
```

Cada tanda WARM de 100 runs produce unos 50 RPC físicos del 96 por la reutilización de rango. Para llegar a 100 pares físicos por variante se repite cada tanda WARM con un directorio nuevo. La primera tanda raw D2 terminó tras 59 parejas válidas y un run fallido por `AUTH_KEY_UNREGISTERED`; una tanda fresca de 50 añadió 50 parejas. No se combinan los intentos fallidos con los percentiles.

```powershell
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-d-mode observe --out tmp/playback-d/d2-warm-repeat
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-d-mode observe --test-d-route-101 download --out tmp/playback-d/d3-warm-repeat
node scripts/run-playback-direct.mjs --runs 50 --mode test-d-raw --test-d-mode observe --out tmp/playback-d/d2-raw-replenish-50
```

Para D4, repetir con `--mode test-d-raw --test-d-mode observe --test-d-order 96|101 --test-d-offset-ms 0|10|50|100`, `--runs 20` y `--out` diferente en cada combinación. El orden indicado es el primero en llegar a la barrera experimental del core; el offset se aplica allí. El modo raw inicia ambas llamadas desde el mismo worker y no depende del scheduler WARM.

[`run-d4.ps1`](run-d4.ps1) ejecuta las siete combinaciones adicionales con 12 parejas por combinación y el control estrictamente secuencial con 20 parejas. El control usa `--test-d-sequential true` (96 termina antes de iniciar 101); sirve para separar «dos RPC en un socket» de «dos RPC simultáneos en un socket».

Para invertir el orden sin introducir la barrera de D4, usar `--test-d-first 101` sin `--test-d-order`: ambas llamadas vuelven a ocurrir en el mismo tick y pueden quedar en una sola escritura WebSocket. Es un control diferente de `--test-d-order 101 --test-d-offset-ms 0`, que pasa por dos timers y puede producir dos escrituras independientes.

```powershell
powershell -NoProfile -File tests/playback-d/run-d4.ps1
node scripts/run-playback-direct.mjs --runs 20 --mode test-d-raw --test-d-mode observe --test-d-first 101 --out tmp/playback-d/d4-101-first-coalesced-20
node scripts/run-playback-direct.mjs --runs 12 --mode test-d-raw --test-d-mode observe --test-d-order 96 --test-d-offset-ms 0 --out tmp/playback-d/d4-96-first-0-gated-12
```

El análisis final de todas las tandas se regenera con:

```powershell
node tests/playback-d/rebuild-report.mjs
```

El reporte escribe `analysis.json`, `RESULTS.md`, `traces/*.jsonl.gz` y `traces/manifest.json`. Git conserva el resumen revisado `RESULTS.md`; los JSON y las trazas detalladas permanecen locales e ignorados. Cada SHA-256 del manifest local comprueba tanto la copia comprimida como los bytes crudos descomprimidos. Los `summary.json`, `runs.csv` y `trace.jsonl` sin comprimir permanecen en `tmp/playback-d/`. Los tiempos `WebSocket.send→rpc_result` son observaciones del cliente; no separan tránsito de red, procesamiento en Telegram y transporte interno.
