# Investigación de playback directo · 5 de octubre de 2026

**Resultado: 44 intentos válidos; no se reprodujeron los tails de 6–12 s.** Cuenta 03, mensaje 96, nombre verificado contra Telegram: `Stage1 Playback v2 03.mp3`, 17 136 bytes. Transporte observado: Bot04, mtcute/web 0.31.0, WebSocket nativo de Node 22.23.2.

Pipeline y ejecución: [README](README.md). El worker, scheduler, caches y mtcute son los de producción del checkout; los cambios locales que ya existían se conservaron. No se optimizó la app.

START se coloca después de preparar sesión y peer. Se mide hasta frames MPEG y PCM real de FFmpeg; MSE, playing, currentTime y salida audible quedan sin medir. El arranque de FFmpeg forma parte del consumidor. Los datos no son comparables directamente con click→progreso de la prueba histórica de cinco cuentas.

## Resultado por condición

| Condición | Runs | START→PCM mínimo–máximo (ms) | START→frames mínimo–máximo (ms) |
|---|---:|---:|---:|
| Frío: worker y autorización nuevos | 12 | 342.7–472.1 | 275.1–371.8 |
| Repeticiones: mismo worker y caché natural | 20 | 70.2–369.2 | 5.2–300.4 |
| WARM solapado con foreground | 6 | 251.6–547 | 185.4–281.9 |
| Dos consumidores foreground simultáneos | 6 | 76.1–365.7 | 6.9–293.7 |

En los 12 intentos fríos: getMessages 97.1–116.9 ms; downloadChunk 165.3–240.4 ms; envío WebSocket→primer evento de respuesta 157.3–231.7 ms; espera de data lane 0 ms. La preparación de sesión, fuera de START, tardó 4 410–5 256.9 ms. No hubo errores/retries de playback ni descargas físicas concurrentes duplicadas en las 44 muestras.

El máximo global, `warm-002`, fue 547 ms: los frames ya estaban a 194.4 ms y los siguientes 352.6 ms correspondieron al consumidor/arranque de FFmpeg. No es un tail de Telegram ni una medición de audio del navegador.

En el primer run WARM y el primer run duplicate se observaron un join de media y un join del rango: un getMessages y un getFile sirvieron a dos consumidores. En los siguientes duplicate, el primer consumidor pudo consumir el caché y el segundo descargar un rango nuevo; ese trabajo secundario no se añade a la latencia del PCM principal. En repeat hubo 10 descargas y 10 lecturas desde caché del worker.

**Conclusión:** esta ruta aislada, con sesión lista y sin INDEX/otros beats/otras cuentas, no reproduce el tail. Por tanto, no hay evidencia para afirmar dónde se fueron los 10–12 s históricos. La herramienta sí deja separadas las fronteras observables para atribuir un futuro caso lento. La espera después del envío por WebSocket sigue incluyendo red y servidor, sin timing interno de Telegram. No se probó saturación de lanes ni comportamiento MSE.

## Tabla por run

Unidades: ms. Despacho + Media + Rango + Entrega/parser + Consumidor = Total PCM, con tolerancia de redondeo. getMessages, getFile y Lane son subdivisiones o trabajo solapado; no se suman otra vez. Sesión previa está fuera del total. Los guiones significan no aplica/no medido.

### Frío: worker y autorización nuevos

[JSON](../../tmp/playback-harness/stream-cold-final-12/summary.json) · [CSV](../../tmp/playback-harness/stream-cold-final-12/runs.csv) · [Trace JSONL](../../tmp/playback-harness/stream-cold-final-12/trace.jsonl)

| Run | Estado | Sesión previa | Despacho | Media | Rango | Entrega/parser | Consumidor PCM | Total PCM | getMessages | getFile | Lane | Cache rango |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cold-001 | OK | 4940.4 | 3 | 119.2 | 171.6 | 4 | 73.1 | 370.9 | 116.6 | 168.9 | 0 | 0 |
| cold-002 | OK | 4942.9 | 2.5 | 109.2 | 184.8 | 2.3 | 69.9 | 368.7 | 105.5 | 182.4 | 0 | 0 |
| cold-003 | OK | 4922.6 | 2.9 | 102.1 | 177.8 | 3.2 | 76.2 | 362.1 | 99.6 | 175.4 | 0 | 0 |
| cold-004 | OK | 5256.7 | 2.8 | 100.7 | 179.7 | 2.9 | 75.8 | 361.9 | 98.1 | 177.2 | 0 | 0 |
| cold-005 | OK | 4739 | 4.8 | 119.4 | 243.1 | 4.5 | 71.8 | 443.6 | 116.8 | 240.4 | 0 | 0 |
| cold-006 | OK | 4552.2 | 2.5 | 100.8 | 177.2 | 4.3 | 90.5 | 375.3 | 97.1 | 174 | 0 | 0 |
| cold-007 | OK | 4518.5 | 2.5 | 100.6 | 189.8 | 42.1 | 137.2 | 472.1 | 98.3 | 187 | 0 | 0 |
| cold-008 | OK | 4937.5 | 4.8 | 106.2 | 182.2 | 3.1 | 104.3 | 400.6 | 103.1 | 179.9 | 0 | 0 |
| cold-009 | OK | 4772.5 | 3.1 | 102 | 187.4 | 1.6 | 78.1 | 372.2 | 99.3 | 185 | 0 | 0 |
| cold-010 | OK | 4409.8 | 2.7 | 103 | 167.8 | 1.5 | 67.6 | 342.7 | 100.6 | 165.3 | 0 | 0 |
| cold-011 | OK | 4775.9 | 2.7 | 106.2 | 175.3 | 1.2 | 68.3 | 353.8 | 103.7 | 172.6 | 0 | 0 |
| cold-012 | OK | 4722.9 | 3 | 119.5 | 197.9 | 1.5 | 67 | 388.9 | 116.9 | 195.7 | 0 | 0 |

### Repeticiones: mismo worker y caché natural

[JSON](../../tmp/playback-harness/stream-repeat-20/summary.json) · [CSV](../../tmp/playback-harness/stream-repeat-20/runs.csv) · [Trace JSONL](../../tmp/playback-harness/stream-repeat-20/trace.jsonl)

| Run | Estado | Sesión previa | Despacho | Media | Rango | Entrega/parser | Consumidor PCM | Total PCM | getMessages | getFile | Lane | Cache rango |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| repeat-001 | OK | 5894.4 | 6.1 | 106.6 | 183.9 | 3.8 | 68.8 | 369.2 | 104.8 | 181.4 | 0 | 0 |
| repeat-002 | OK | — | 2.6 | 0.4 | 0.5 | 4.8 | 68.3 | 76.6 | 0 | 0 | 0 | 1 |
| repeat-003 | OK | — | 3.3 | 0.3 | 171 | 7.9 | 66.4 | 248.9 | 0 | 169.8 | 0 | 0 |
| repeat-004 | OK | — | 2.7 | 0.1 | 0.3 | 5 | 70.9 | 78.9 | 0 | 0 | 0 | 1 |
| repeat-005 | OK | — | 6.6 | 0 | 169.4 | 2.3 | 67.7 | 246.1 | 0 | 168.8 | 0 | 0 |
| repeat-006 | OK | — | 4.1 | 0.2 | 0.3 | 3.4 | 63.6 | 71.5 | 0 | 0 | 0 | 1 |
| repeat-007 | OK | — | 2.2 | 0.1 | 172.7 | 4.3 | 67.7 | 246.9 | 0 | 172.1 | 0 | 0 |
| repeat-008 | OK | — | 2.2 | 0.1 | 0.4 | 3 | 66.5 | 72.2 | 0 | 0 | 0 | 1 |
| repeat-009 | OK | — | 2.3 | 0.1 | 171.7 | 3.5 | 75.8 | 253.5 | 0 | 171.2 | 0 | 0 |
| repeat-010 | OK | — | 3.9 | 0.2 | 0.7 | 3 | 69 | 76.9 | 0 | 0 | 0 | 1 |
| repeat-011 | OK | — | 2.4 | 0.1 | 192.1 | 2.9 | 66.9 | 264.3 | 0 | 191.6 | 0 | 0 |
| repeat-012 | OK | — | 2.4 | 0 | 0.2 | 4.2 | 65.3 | 72.1 | 0 | 0 | 0 | 1 |
| repeat-013 | OK | — | 2.4 | 0.1 | 168.3 | 3.1 | 69.2 | 243.1 | 0 | 167.7 | 0 | 0 |
| repeat-014 | OK | — | 2.1 | 0.1 | 0.2 | 3.9 | 66.3 | 72.6 | 0 | 0 | 0 | 1 |
| repeat-015 | OK | — | 4 | 0.2 | 164.2 | 5 | 60.9 | 234.3 | 0 | 163.6 | 0 | 0 |
| repeat-016 | OK | — | 2.3 | 0.2 | 0.3 | 6 | 65.5 | 74.3 | 0 | 0 | 0 | 1 |
| repeat-017 | OK | — | 2.6 | 0.2 | 187.2 | 2.3 | 68.6 | 260.9 | 0 | 186.5 | 0 | 0 |
| repeat-018 | OK | — | 2.1 | 0.1 | 0.3 | 3.1 | 64.6 | 70.2 | 0 | 0 | 0 | 1 |
| repeat-019 | OK | — | 2.1 | 0.1 | 181.2 | 2.7 | 80.3 | 266.4 | 0 | 180.4 | 0.2 | 0 |
| repeat-020 | OK | — | 2 | 0.1 | 0.2 | 2.9 | 78 | 83.2 | 0 | 0 | 0 | 1 |

### WARM solapado con foreground

[JSON](../../tmp/playback-harness/stream-warm-06/summary.json) · [CSV](../../tmp/playback-harness/stream-warm-06/runs.csv) · [Trace JSONL](../../tmp/playback-harness/stream-warm-06/trace.jsonl)

| Run | Estado | Sesión previa | Despacho | Media | Rango | Entrega/parser | Consumidor PCM | Total PCM | getMessages | getFile | Lane | Cache rango |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| warm-001 | OK | 4744.8 | 27.9 | 82.4 | 167.6 | 4 | 74 | 355.9 | 101 | 167.4 | 0 | 0 |
| warm-002 | OK | — | 19.9 | 0.2 | 170.1 | 4.1 | 352.6 | 547 | 0 | 169.7 | 0 | 1 |
| warm-003 | OK | — | 20 | 0.2 | 183.5 | 2.2 | 66.4 | 272.2 | 0 | 183 | 0 | 1 |
| warm-004 | OK | — | 18 | 0.1 | 179.9 | 3.8 | 68.4 | 270.1 | 0 | 179.4 | 0 | 1 |
| warm-005 | OK | — | 17.6 | 0.3 | 162.7 | 4.8 | 66.1 | 251.6 | 0 | 162.2 | 0 | 1 |
| warm-006 | OK | — | 17.9 | 0.1 | 186.9 | 2.4 | 65.5 | 272.9 | 0 | 186.3 | 0 | 1 |

### Dos consumidores foreground simultáneos

[JSON](../../tmp/playback-harness/stream-duplicate-06/summary.json) · [CSV](../../tmp/playback-harness/stream-duplicate-06/runs.csv) · [Trace JSONL](../../tmp/playback-harness/stream-duplicate-06/trace.jsonl)

| Run | Estado | Sesión previa | Despacho | Media | Rango | Entrega/parser | Consumidor PCM | Total PCM | getMessages | getFile | Lane | Cache rango |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| duplicate-001 | OK | 4645.1 | 3.2 | 106.3 | 179 | 5.2 | 72 | 365.7 | 102.5 | 176.7 | 0 | 0 |
| duplicate-002 | OK | — | 2.2 | 0.3 | 0.6 | 3.9 | 75.1 | 82 | 0 | 176.4 | 0 | 1 |
| duplicate-003 | OK | — | 2.4 | 0.2 | 0.5 | 4.9 | 73 | 80.9 | 0 | 174.1 | 0 | 1 |
| duplicate-004 | OK | — | 2.1 | 0.3 | 0.5 | 4.8 | 68.4 | 76.1 | 0 | 172 | 0 | 1 |
| duplicate-005 | OK | — | 6.3 | 0.2 | 0.3 | 2.7 | 67.3 | 76.8 | 0 | 167.4 | 0 | 1 |
| duplicate-006 | OK | — | 2.8 | 0.1 | 0.3 | 4.2 | 74.1 | 81.5 | 0 | 174.1 | 0 | 1 |

## Exploraciones y validación

- Antes de la serie principal se completaron 12 intentos fríos por `prefetch`, con máximo 655 ms a PCM: [evidencia](../../tmp/playback-harness/cold-12/report.md). No se mezclan con stream.
- Una primera serie fría de stream alcanzó 7 runs válidos y se detuvo preparando la sesión 8 por `invalid nonce hash from server`, antes de START: [evidencia sin ocultar el fallo](../../tmp/playback-harness/stream-cold-12/summary.json). El adaptador inicial no copiaba el reintento de bootstrap existente en la app; se alineó a su política de dos intentos sólo ante ese error. La serie final de 12 completó. No fue un fallo de Play ni se cambió el retry de producción.
- Smoke final del harness: 2/2, 349.7 y 76.1 ms a PCM, con verificación adicional de bytes devueltos por core.call: [evidencia](../../tmp/playback-harness/final-smoke-02/report.md).
- Seis tests de contabilidad del reporte pasan: partición aditiva, null de ingress, aislamiento por run, errores en CSV, trabajo secundario y conteo de bytes sin duplicación. También pasan los dos tests existentes de playbackGetFileTrace.
- Las tablas se reconstruyeron desde JSONL original, sin cambiar las trazas. summary.json conserva hashes del código ejecutado y del generador del reporte. Las capturas de repeat anteriores al probe MTCUTE adicional dejan esas columnas null; no se inventaron valores.
