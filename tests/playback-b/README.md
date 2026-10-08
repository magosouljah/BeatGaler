# Test B · Play → progreso real en navegador mínimo

`scripts/run-playback-b.mjs` prueba la cuenta Stage1 `03`, Telegram `message_id 96`, `Stage1 Playback v2 03.mp3`. Comprueba el nombre devuelto por `getMessages` antes de aceptar una serie. Usa el control plane y autorización temporal reales; en Chrome headless ejecuta `WebTransportWorkerClient`, el worker MTProto y `WebPlaybackSourceManager` de producción. El extremo de prueba crea solo un `<audio>` silenciado, llama `play()` y espera `currentTime >= 0.5`. No inicia React ni la aplicación completa.

## Ejecutar

Requiere Node 22, dependencias del repo, Chrome/WebdriverIO, `.env.stage1` existente y Cloud/PostgreSQL activos. Si Cloud no está iniciado:

```powershell
cd E:/777/app/beatvault/cloud-server
node --env-file=.env server.js
```

Desde la raíz del repo, en otra terminal:

```powershell
node scripts/run-playback-b.mjs --runs 25 --mode source-cold
node scripts/run-playback-b.mjs --runs 12 --mode warm --warm-message-ids 101
node scripts/run-playback-b.mjs --runs 6 --mode cold
node scripts/run-playback-b.mjs --runs 8 --mode index
node scripts/run-playback-b.mjs --runs 6 --mode overlap
node scripts/run-playback-b.mjs --runs 6 --mode repeat
```

`--out tmp/playback-harness/<nombre>` fija una carpeta nueva de salida. Nunca sobrescribe un `trace.jsonl` existente. `--help` muestra opciones. Las condiciones son:

- `source-cold` (default): cada Play borra el caché de fuente/prefijo, conservando sesión y caché natural del worker. El primer run prepara sesión y peer después de `INTENT_BEGIN`.
- `repeat`: conserva también la fuente completa entre intentos; mide el replay natural.
- `cold`: autorización temporal, worker, peer y cachés nuevos **en cada run**. Es una condición de peor caso deliberada, no representa automáticamente un clic normal en la app.
- `warm`: comienza WARM 10 ms antes del Play. `--warm-message-ids 101` añade un competidor válido al mismo lote y lo vuelve a solicitar en cada run. `--warm-lead-ms` cambia ese adelanto.
- `index`: inicia un `getLibraryIndex()` real 10 ms antes del Play, para observar preemption. Es una lectura; no escribe INDEX.
- `overlap`: inicia dos intents del mismo beat separados por 10 ms y reproduce el segundo.

`--mime audio/unsupported` fuerza la rama Blob para comprobar la selección de fuente. Es una condición artificial para el mensaje 96, cuyo MIME normal es `audio/mpeg`; no debe mezclarse con las muestras MSE al comparar latencia.

Cada ejecución escribe `trace.jsonl` (eventos con `run_id`, `intent_id` y epoch ms), `runs.csv`, `summary.json` y `report.md` (tabla por run y timeline de los ≥6 s). La clave temporal y los tokens no se guardan. El script arranca Vite únicamente para servir el módulo del test al navegador; no monta la UI.

## Lectura de las etapas

`INTENT_BEGIN → START` incluye sesión/peer si son nuevos. `START → foco → URL → playing → currentTime >= 0.5` son tramos sucesivos. `getMessages`, `getFile`, lane y primer byte son detalles internos de esos tramos que pueden solaparse: **no se suman otra vez**. En `warm`, un primer byte anterior a START aparece con tiempo negativo porque el WARM comenzó antes del intento.

El wrapper `worker.ts` solo reenvía trazas estructuradas y verifica el nombre; no sustituye el worker ni mtcute. El transporte mínimo de `browser.ts` delega en `WebTransportWorkerClient`, con el peer verificado como precondición, y conserva callbacks/ACK reales del stream. La diferencia frente a la app es que no se ejecutan `WebGalerCloudTransport`/`WebTransportController`, `webAdapter`, observador de tarjetas, coordinador de startup, React ni varias cuentas a la vez. La preparación temporal de sesión sí usa los endpoints reales, pero el script Node hace reserve/bind/activate y entrega la sesión al worker del navegador.

`playing` y `currentTime` prueban que el navegador avanzó el audio; el modo headless silenciado no prueba salida física por altavoces. `WORKER_GET_FILE_RPC_RESULT_ENTER` identifica la respuesta del RPC y su frame WebSocket. El intervalo envío→respuesta incluye red, Telegram y la pila MTProto; no separa el procesamiento interno de Telegram.

## Verificación y resultados

```powershell
node --test tests/playback-b/report.test.mjs
npm run test:typecheck
node tests/playback-b/rebuild-report.mjs tmp/playback-harness/<directorio>
```

La serie medida y la atribución del tail están en [RESULTS.md](RESULTS.md).
