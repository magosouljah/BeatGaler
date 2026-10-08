# Atribución de Plays lentos después del fix de transporte

## Estado y evidencia de versión

Fix cerrado en `f067c21c9280ce2b6f9a17c91461865c22c347a8` (`fix(playback): isolate MTProto framed writes`). El commit incluye el parche reproducible de `@fuman/io` por `postinstall`/lockfile y Test F; no incluye esta investigación. Test F pasó 25/25 y Test E real, 200/200 pares concurrentes en el mismo socket con writes separados y 0 tails ≥6 s.

El Task0 histórico (`tmp/phase2-task0/20261008-000226142`) corrió antes de ese commit, pero su `web_dist_sha256` es `3ec7f0691fdb2cd9ee171b0269feef45f7d7a8525efeca8ab38da42b3d770429`, idéntico al de las dos repeticiones con HEAD `f067c21`. En el bundle `dist/assets/webTransport.worker-KxwdYaYG.js`, la implementación compilada de `FramedWriter.write` crea `alloc(...)` por llamada y entrega `new Uint8Array(...)`; los módulos ESM y CJS instalados tienen el mismo cambio. El runner inicia un WDIO nuevo en cada run con perfil Chrome `run-${pid}-${Date.now()}`, y cada Reload crea un nuevo `Worker`; por construcción, ese Chrome/worker no puede reutilizar un socket de un proceso anterior. En la captura reciente se observaron IDs de worker distintos por Reload y conexiones `client-1` activas. **Fresh worker/socket histórico: derivado del ciclo de vida y de la identidad del build; no hay ID de socket ni prueba de identidad de buffers guardada por Play histórico.** Writes independientes: verificados en código compilado y Test E/F, no registrados individualmente en esos seis Plays.

## Los 60 Plays históricos

Fuente: `tmp/phase2-task0/20261008-000226142/run-0{1,2,3}-measurement-raw.json`. Tres runs válidos, 20 Plays cada uno, sin errores funcionales; p50 2,748 ms, p95 10,520 ms, máximo 12,136 ms, 6/60 ≥6 s. Los seis son de **ronda 1**: cinco simultáneos en run 1 y uno en run 3. Las rondas 2–4 suman 45 Plays y 0 ≥6 s. Los JSON históricos guardan sólo `clicked_at_ms` y `first_playing_at_ms` para cada Play: ninguno tiene `main_play_trace` ni `worker_path_trace`, y el log histórico no contiene `[play-trace]`. Por ello la agrupación de estos 60 por etapa es **no disponible**; agrupar los seis como `getFile`, WARM o audio sería inventar datos.

`ND` = no disponible. Los totales son medidos desde antes de `await artwork.click()` hasta observar `playing` con `currentTime ≥0.5`; no son click DOM→primer evento `playing`.

| Run / cuenta / ronda | Total (ms) | Controller | WARM/adoption | Source prepare | Session/peer | getMessages | Lane | getFile send→result | First bytes | MSE/audio | Etapa dominante |
|---|---:|---|---|---|---|---|---|---|---|---|---|
| 1 / 01 / 1 | 10,520 | ND | ND | ND | ND | ND | ND | ND | ND | ND | ND |
| 1 / 02 / 1 | 11,597 | ND | ND | ND | ND | ND | ND | ND | ND | ND | ND |
| 1 / 03 / 1 | 11,109 | ND | ND | ND | ND | ND | ND | ND | ND | ND | ND |
| 1 / 04 / 1 | 7,155 | ND | ND | ND | ND | ND | ND | ND | ND | ND | ND |
| 1 / 05 / 1 | 12,136 | ND | ND | ND | ND | ND | ND | ND | ND | ND | ND |
| 3 / 05 / 1 | 6,351 | ND | ND | ND | ND | ND | ND | ND | ND | ND | ND |

## Reproducción con trazas existentes

Se repitió Task0 **sin editar producción**, con `PLAYBACK_GET_FILE_CAPTURE=1` (habilita Chrome browser logging y copia las trazas existentes al reporte). Series `tmp/phase2-task0/20261008-032036384` y `tmp/phase2-task0/20261008-033202988`: 3 runs válidos y 60/60 Plays en cada una, 0 ≥6 s en 120 Plays. Primera: p50 2,019, p95 4,726, máximo 4,987 ms. Segunda: p50 2,238, p95 3,614, máximo 4,869 ms. El cambio de logging y el momento de ejecución impiden tratar estas series como repetición idéntica de las latencias históricas.

Agrupación por mayor intervalo observado por Play. `Comando WebDriver→click DOM` empieza con `clicked_at_ms` **antes** de ejecutar `artwork.click()`; `playing→progreso` acaba al observar `currentTime ≥0.5`, no al empezar a sonar. Es una partición de tiempo observable, no una clasificación de causa raíz:

| Mayor intervalo | Primera serie (60) | Segunda serie (60) | Total (120) | Tails ≥6 s |
|---|---:|---:|---:|---:|
| `playing`→progreso ≥0.5 s | 51 | 51 | 102 | 0 |
| Comando WebDriver→click DOM | 7 | 7 | 14 | 0 |
| Controller→prefijo listo | 2 | 1 | 3 | 0 |
| Rango MSE reproducible→`playing` | 0 | 1 | 1 | 0 |

Una traza de la primera serie muestra una espera previa real y distinta del mecanismo de FramedWriter: run 3, cuenta 03, ronda 1, total **4,576 ms**. Tiempos relativos a `clicked_at_ms`, medidos salvo donde se indica:

| Etapa/evento | Marca o duración (ms) |
|---|---:|
| Click DOM → controller | +434 → +438 |
| WARM promovido; sesión reutilizada/peer listo | +482; +485 |
| Request de prefetch enviado/recibido por worker | +486 / +512 |
| `getMessages` begin→done | +517 → +2,547 = **2,030** |
| Lane adquirida; descarga del prefijo | +2,549; +2,549 → +3,227 |
| `upload.getFile(96)` `WebSocket.send`→`rpc_result` correlacionado | +2,559 → +3,226 = **667** |
| Prefijo recibido por main; source prepare | +3,231; +3,232 |
| Primer rango MSE; evento `playing`; progreso ≥0.5 s | +3,441; +3,750; +4,576 |

Aquí domina la espera observable de `getMessages` (2,030 ms); los 667 ms de `WebSocket.send→rpc_result` no separan red, Telegram ni transporte interno. Este Play **no** es uno de los seis históricos ≥6 s, y no demuestra que tengan la misma causa. Los 120 Plays nuevos tampoco prueban que todos los `getFile` históricos fueran rápidos: esos seis carecen de marcas RPC.

## Tests 37/39 y siguiente paso

Las dos aserciones señaladas son `webTransportWorker.test.ts` (índice pinned ausente) y `webTransportWorkerScheduler.behavior.test.ts` (abortar INDEX al llegar WARM). La selección focalizada previa fue 37/39; al repetir sólo estos dos archivos, excluyendo copias bajo `tmp/`, el resultado fue 26/28 con **exactamente las mismas dos** aserciones fallidas. Ambos archivos ya estaban modificados antes del commit del transporte y usan mocks de `@mtcute/web`; no ejercitan el `FramedWriter` real, así que sus fallos no son una regresión demostrada del parche. El segundo sí puede importar para la coordinación WARM/INDEX y merece investigación separada; no se cambió ninguna aserción.

**Conclusión:** el mecanismo específico de buffer compartido queda descartado por Test E/F y por el bundle usado. La etapa dominante de los **seis** tails full app no se puede determinar con los datos guardados. El siguiente cambio recomendado es de medición en el harness: conservar automáticamente, sólo en Plays ≥6 s, marcas por `request_id`/`message_id` desde click DOM real hasta progreso, ID de worker/socket y pares `WebSocket.send`→`rpc_result`, además de informar por separado la espera del comando WebDriver y la del umbral de 0.5 s. Después, reproducir tails y decidir un fix sobre la etapa observada; no se implementó otro fix aquí.
