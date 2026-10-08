# Test G — Plays residuales de 3–5 s

Fuente principal: Task0/full-app real, cinco cuentas y cuatro Plays por cuenta en cada run. La serie previa con trazas (`tmp/phase2-task0/20261008-032036384` y `20261008-033202988`) aporta 120 Plays, 23 de ellos ≥3 s. No se altera el tiempo de red ni el scheduler para provocar latencia.

La instrumentación de Test G sólo observa la ruta existente: conserva las marcas de click DOM y progreso, y añade correlación por método y `batch_id` a los hooks ya presentes de mtcute para separar `getMessages` lógico, enqueue, flush, `WebSocket.send` y `rpc_result`. Se guardan IDs de mensaje y conexión, nunca cuerpo RPC, peer, sesión ni bytes cifrados. El hook sigue llamando a las funciones originales.

Ejecución en PowerShell, con `.env.stage1`, Cloud/PostgreSQL y Chrome según Task0:

```powershell
$env:PLAYBACK_GET_FILE_CAPTURE='1'
$env:PLAYBACK_TEST_G_CAPTURE='1'
$env:VITE_PLAYBACK_TEST_G_CAPTURE='1'
$env:VITE_PLAYBACK_TEST_G_MESSAGE_ID='96'
node scripts/run-phase2-task0-measurements.mjs --runs 3
```

`VITE_PLAYBACK_TEST_G_MESSAGE_ID` fija la observación del batch que contiene el mensaje 96 incluso si WARM lo resuelve antes del click. Los directorios `tmp/phase2-task0/<timestamp>/` contienen las trazas por run. Ejecutar series sucesivas secuencialmente.

Para regenerar las 109 timelines de los cinco directorios válidos del informe:

```powershell
node tests/playback-g/analyze.mjs --slow-only tmp/phase2-task0/20261008-032036384 tmp/phase2-task0/20261008-033202988 tmp/phase2-task0/20261008-053531115 tmp/phase2-task0/20261008-054917675 tmp/phase2-task0/20261008-060501314 > tests/playback-g/timelines.json
node tests/playback-g/render-timelines.mjs tests/playback-g/timelines.json > tests/playback-g/TIMELINES.md
```

Sin `--slow-only`, el analizador emite también los Plays rápidos para calcular distribuciones y correlaciones. Las trazas originales permanecen en `tmp`; `timelines.json` es un derivado local ignorado por Git y `TIMELINES.md` conserva el resumen legible. `RESULTS.md` registra el análisis, las limitaciones y la decisión de fix.
