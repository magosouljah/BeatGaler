# Test B · resultados del 6 de octubre de 2026

**92/92 runs válidos** sobre cuenta 03, mensaje 96. El archivo de Telegram se verificó como `Stage1 Playback v2 03.mp3` (17 136 bytes). Se midió hasta `currentTime >= 0.5 s` en Chrome headless. Los percentiles usan nearest rank y no mezclan runs fallidos.

Con sesión/peer **ya listos**: 78 runs, p50 **852.7 ms**, p95 **2 559.2 ms**, máximo **7 564.6 ms**; **1/78 ≥6 s**. Con sesión/peer creados después de `INTENT_BEGIN`: 14 runs, p50 **7 058.8 ms**, p95 **9 448 ms**, máximo **9 448 ms**; **14/14 ≥6 s**. Esta última es una condición fría deliberada y no demuestra que las sesiones de la prueba histórica estuvieran frías.

| Serie y tabla por run | Runs | p50 ms | p95 ms | Máx ms | ≥6 s |
|---|---:|---:|---:|---:|---:|
| [Fuente fría, misma sesión](../../tmp/playback-harness/test-b-source-cold-25/report.md) | 25 | 998.4 | 1 253 | 7 089.9 | 1 |
| [WARM con 90/101](../../tmp/playback-harness/test-b-warm-batch-15/report.md) | 15 | 990.5 | 7 163.4 | 7 163.4 | 1 |
| [Sesión nueva por run](../../tmp/playback-harness/test-b-session-cold-06/report.md) | 6 | 6 383 | 6 962.3 | 6 962.3 | 6 |
| [Replay natural](../../tmp/playback-harness/test-b-repeat-06/report.md) | 6 | 821.8 | 7 163.9 | 7 163.9 | 1 |
| [INDEX concurrente](../../tmp/playback-harness/test-b-index-08/report.md) | 8 | 846.5 | 7 463 | 7 463 | 1 |
| [Intents superpuestos](../../tmp/playback-harness/test-b-overlap-06/report.md) | 6 | 840.5 | 7 058.8 | 7 058.8 | 1 |
| [WARM 101, serie A](../../tmp/playback-harness/test-b-warm101-10/report.md) | 10 | 856.2 | 7 111.3 | 7 111.3 | 1 |
| [WARM 101, serie B](../../tmp/playback-harness/test-b-warm101-12b/report.md) | 12 | 863.6 | 9 448 | 9 448 | 2 |
| [Blob forzado](../../tmp/playback-harness/test-b-blob-04/report.md) | 4 | 857.6 | 9 024.2 | 9 024.2 | 1 |

El primer run de cada serie incluye sesión nueva; en «sesión nueva por run» la incluye cada fila. Por eso los p95 de varias series reflejan sobre todo ese primer arranque. Cada reporte enlazado contiene la **tabla de todos sus runs** y el timeline de los ≥6 s; los JSONL y CSV están en la misma carpeta.

## Tail reproducido con sesión lista

[`warm-011`, serie B](../../tmp/playback-harness/test-b-warm101-12b/report.md): **7 564.6 ms** desde intent hasta `currentTime >= 0.5 s`, sin preparación de sesión. Los tramos sucesivos fueron: intent→START 43.3 ms; START→foco 9.8 ms; foco→URL **6 700.6 ms**; URL→`playing` 22.6 ms; `playing`→0.5 s 788.3 ms.

- Antes del clic, WARM del 96 y 101 ya compartían lote. Los descriptores de ambos estaban en caché; `getMessages` no se llamó. El mensaje 96 obtuvo lane sin espera medible.
- `upload.getFile` del 96 se envió por WebSocket a **+3.3 ms** desde START. Su frame de respuesta correlacionado llegó a **+6 700.9 ms**; `RPC_RESULT_ENTER` ocurrió a +6 702.9 ms. No hubo retry de ese RPC. El foco abortó el WARM competidor 101, no el del 96.
- El prefijo del 96 estuvo disponible a +6 709 ms, la URL a +6 710.4 ms, `sourceopen` a +6 717 ms y `playing` a +6 733 ms. El primer progreso llegó a +6 973.7 ms y `currentTime >= 0.5 s` a +7 521.3 ms desde START.

También aparecieron esperas de respuesta de `getFile` del 96 de **4 018.6 ms** ([`warm-009`, serie A](../../tmp/playback-harness/test-b-warm101-10/report.md), total 4 863.2 ms) y **4 198.5 ms** ([`warm-009`, serie B](../../tmp/playback-harness/test-b-warm101-12b/report.md), total 5 089.9 ms). Las tres tuvieron lane wait ~0, media en caché y MSE→`playing` de decenas de milisegundos.

**Conclusión acotada:** Test B sí reproduce un tail de Play con sesión lista, y en ese run los 6.7 s se acumulan esperando la respuesta correlacionada de `upload.getFile` después del envío WebSocket. Esto descarta como causa inmediata de *ese run* la resolución de `getMessages`, la cola de lanes y MSE. El intervalo aún engloba red, Telegram y transporte MTProto; no atribuye tiempo interno al servidor. El WARM/adopción hace que la URL espere esa respuesta, pero esta prueba no demuestra que la política WARM haya causado la demora del RPC.

INDEX provocó marcas de preemption y los dos intents se solaparon, sin producir por sí mismos otro ≥6 s con sesión lista en sus series. El Blob forzado eligió la rama correcta, pero el archivo 96 cabe entero en el prefijo de 64 KiB; estos cuatro runs no prueban el costo de esperar un archivo grande completo. Quedan fuera el observador de tarjetas, startup coordinator, `webAdapter`, `WebGalerCloudTransport` y la carga simultánea de las cinco cuentas. Esas capas aún podrían añadir o cambiar tails de la app completa.
