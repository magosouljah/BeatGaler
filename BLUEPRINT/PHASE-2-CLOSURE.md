# Fase 2 — cierre

## Scope

Fase 2 midió y estabilizó el recorrido Web real de cinco cuentas: apertura fría, biblioteca autoritativa, reapertura y Reload calientes, INDEX/Direct y Play con progreso. Task 0 definió las cuatro condiciones y la validez de cada corrida en [`PHASE2-TASK0-MEASUREMENT.md`](../tests/e2e-web/PHASE2-TASK0-MEASUREMENT.md); Task 1 atribuyó la latencia de biblioteca y Task 2 corrigió y volvió a verificar los fallos de sesión, puntero INDEX y ping. Sus pruebas ya tenían evidencia y no se repitió toda la fase para este cierre.

## Blocker final y causa demostrada

El blocker restante era la demora crítica de Play, reproducida incluso con sesión y peer preparados. [Test B](../tests/playback-b/RESULTS.md) observó un Play de 7,565 ms, de los cuales 6,701 ms transcurrieron entre `WebSocket.send` y la respuesta correlacionada de `upload.getFile`. [Test D](../tests/playback-d/RESULTS.md) vinculó los tails a dos RPC concurrentes en el mismo socket. [Test E](../tests/playback-e/RESULTS.md) demostró la causa local: `FramedWriter` reutilizaba un buffer durante dos `encode()` solapados, por lo que dos paquetes MTProto cifrados independientes podían llegar concatenados a una sola llamada `WebSocket.send()`. En E1 hubo 139/217 pares físicos válidos de ≥6 s con writes conjuntas; con buffer independiente hubo 0/500 y writes separadas. No se observó el procesamiento interno de Telegram, así que la atribución termina en la frontera de escritura del cliente y la respuesta RPC.

## Fix

El commit `f067c21c9280ce2b6f9a17c91461865c22c347a8` cambia `@fuman/io` 0.0.21 mediante [`patches/@fuman+io+0.0.21.patch`](../patches/@fuman+io+0.0.21.patch): cada `FramedWriter.write()` codifica en su propio `Bytes` y entrega una copia independiente. `postinstall` y el lockfile aplican el parche de forma reproducible. [Test F](../tests/playback-f/README.md) protege ambos órdenes de la carrera y exige una escritura WebSocket por paquete. La transición requiere nuevos workers/sockets mediante reinicio o Reload de las pestañas que conservaran el bundle anterior.

## Evidence

- **Fix aislado:** [resultados F](../tests/playback-f/RESULTS.md): regresión 25/25; cuatro tandas reales, 200/200 pares concurrentes válidos con writes separadas, `upload.getFile` p95 168.6 ms, máximo 193.2 ms y 0 ≥6 s.
- **App completa:** Task 0 histórico post fix registró 60 Plays válidos, 0 errores funcionales y 6 ≥6 s. La identidad del bundle parcheado está documentada en el [análisis post fix](../tests/playback-post-fix/RESULTS.md), pero esos seis Plays no guardaron traza RPC suficiente para atribuir su etapa. Dos repeticiones posteriores, `tmp/phase2-task0/20261008-032036384` y `20261008-033202988`, tuvieron 120/120 Plays válidos y 0 ≥6 s; sus JSON crudos permanecen locales, fuera de Git.
- **Tiempos residuales:** [Test G](../tests/playback-g/RESULTS.md) separó el tiempo anterior al click DOM, la preparación, el primer `playing` y el evento de progreso `currentTime ≥0.5`. Muchos totales de 3–5 s están dominados por WebDriver antes del click o por el progreso de audio observado en Chrome headless después de recibir datos. En series con más instrumentación sí reaparecieron totales ≥6 s; esto no demuestra una nueva regresión del writer ni permite afirmar que todo Play de producto cumple un umbral fijo. Dos esperas antiguas de metadata de ~2 s carecen de desglose físico concluyente. No se alteró el camino funcional de Play para perseguirlas sin causa probada.
- **Resto de Fase 2:** las mediciones de [Task 1](../tests/e2e-web/PHASE2-TASK1-LIBRARY-LATENCY.md) y [Task 2](../tests/e2e-web/PHASE2-TASK2-INDEX-POINTER.md) ya estaban registradas. El run estricto posterior a la estabilización `tmp/phase2-task2/20261002-232224156/` (artefacto local ignorado) informó cinco bibliotecas frías, cinco Reload, diez Plays reales y cero ping timeouts; hubo tres recuperaciones de socket INDEX. Se conserva el resumen, sin subir trazas de cuentas/sesiones.
- **Aceptación manual:** el usuario comunicó en la solicitud de cierre que la reproducción se siente rápida y que el fallo anterior no volvió a percibirse. Es aceptación manual reportada, no una medición automatizada ni un artefacto de Git.
- **Validación de cierre (2026-10-08):** Test F 2/2; selección de playback/transport/integración 76/76; pruebas de reportes 8/8; reproducción determinista de Test E; `npm run test:typecheck` y `npm run build:web`, PASS. Las trazas extensas y los JSON generados quedan locales bajo `tmp/` o ignorados.

## Final decision

**PHASE 2 — CLOSED.** Las pruebas previas de la fase ya estaban aceptadas; playback/latencia era el blocker final. El defecto de escritura quedó reproducido, corregido y protegido por Test F, validado con RPC reales y con la app completa. La aceptación manual confirma el resultado percibido. Las limitaciones del harness headless y las dos esperas de metadata se registran sin convertirlas en una causa de producción no demostrada.

## Canonical state

- Branch: `integration-v0.9.0-alpha.4`.
- SHA del fix verificado: `f067c21c9280ce2b6f9a17c91461865c22c347a8`.
- SHA final del cierre: HEAD de `origin/integration-v0.9.0-alpha.4` tras el push; el valor exacto se registra en la entrega del cierre (`git rev-parse origin/integration-v0.9.0-alpha.4`). Un commit no puede contener su propio SHA literal.
- Fecha: 2026-10-08 (America/Mexico_City).
- Resultado: **PHASE 2 — CLOSED**.
