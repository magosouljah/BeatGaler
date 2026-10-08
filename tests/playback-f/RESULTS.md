# Implementación y resultados · Test F

## Cambio

- `patches/@fuman+io+0.0.21.patch`: buffer de encode y copia de salida independientes por `FramedWriter.write()` en ESM y CommonJS.
- `package.json` y `package-lock.json`: `patch-package` como dependencia de producción, `postinstall` y comando permanente de Test F.
- `.gitignore`: permite versionar este parche concreto dentro de `patches/`.
- `tests/playback-f/transport-boundary.test.mjs`: regresión determinista sin red.
- `tests/playback-f/analyze.mjs`: validación de pares físicos de Test E con el writer instalado.

La reproducción sin parche falló en las dos variantes de Test F (`send(A || B)` en vez de dos sends). Tras reaplicar el parche, 25/25 ejecuciones pasaron. `npm ci` desde el lockfile aplicó `@fuman/io@0.0.21` correctamente. Typecheck y build Web pasaron.

## Test E con producción

Baseline anterior con buffer compartido: 139/217 pares físicos válidos ≥6 s.

Con este parche y el mismo socket, en cuatro tandas de 50 pares (`tmp/playback-f/e-prod-02` a `e-prod-05`):

- 200/200 pares físicos válidos, 200/200 RPC concurrentes y 200/200 writes separadas.
- `upload.getFile(96)` desde `WebSocket.send()` hasta `rpc_result`: p50 **94 ms**, p95 **168.6 ms**, p99 **185.5 ms**, máximo **193.2 ms**.
- ≥1.5 s: **0**; ≥3 s: **0**; ≥6 s: **0**; ≥9 s: **0**.
- Runs con state request, reconnect, error de auth o flood: **0** cada uno.

Un intento previo de preparación terminó antes de START con `invalid nonce hash` en la autorización temporal y no aportó runs. La tanda siguiente y las otras tres terminaron completas. Los percentiles anteriores solo incluyen respuestas correlacionadas de los 200 pares válidos.

## Task0 full app

El protocolo de cinco cuentas y cuatro condiciones terminó `BASELINE_COMPLETE`: tres corridas válidas, 60 Plays y **0 errores funcionales**. Comparación de Play clic→audio sonando con progreso, baseline `tmp/phase2-task0/20261006-010032321` y nuevo `tmp/phase2-task0/20261008-000226142`:

- Antes (60): p50 **1,939 ms**, p95 **9,951 ms**, máximo **12,380 ms**; ≥6 s **5**.
- Después (60): p50 **2,748 ms**, p95 **10,520 ms**, máximo **12,136 ms**; ≥6 s **6**.

Una corrida adicional nueva (`tmp/phase2-task0/20261007-235406577`) también fue válida, con 20 Plays y 0 errores: p50 2,647 ms, p95 6,416 ms, máximo 6,672 ms, ≥6 s 3. No se agrega a la comparación de 60 contra 60.

La condición física de Test E desapareció, pero **el criterio de mejora de startup full app no quedó demostrado**. El baseline anterior procede de otra fecha y revisión del checkout; esta comparación no aísla causalmente el parche. Task0 mide el recorrido completo y no atribuye esos tails restantes a `FramedWriter`, Telegram, la red u otra etapa. El parche corrige el aliasing comprobado; no hay evidencia para presentarlo como solución completa de la latencia de Play del producto.

## Checks y límites

La suite focalizada `webPlaybackSource` pasó 11/11. La selección scheduler/worker/source terminó 37/39: fallaron una aserción de INDEX ausente y otra de aborto de INDEX ante WARM en archivos que ya estaban modificados antes de este parche. La suite de integración amplia también mostró aserciones estáticas incompatibles con esos cambios previos. No se modificaron esas pruebas ni su código por este fix.

Riesgos restantes: pestañas sin recargar conservan el writer antiguo; el buffer y la copia por paquete añaden asignaciones de memoria; y los tails full app observados requieren atribución aparte si el objetivo es mejorar Play end to end. Las marcas `WebSocket.send()`→`rpc_result` no separan red, procesamiento remoto ni MTProto interno.
