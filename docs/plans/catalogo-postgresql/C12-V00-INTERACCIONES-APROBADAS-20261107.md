# C12 — V00: Interacciones globales aprobadas para Gallery infinita

**Fecha:** 2026-11-07. **Rama:** `local/landing-gallery-unificada`. **Estado de V00-interacciones:** APROBADAS POR PRODUCTO, pendientes implementación y pruebas. **Alcance:** diseño de futura Gallery POSTGRES; no cambia LEGACY, DESIGN, producción ni bibliotecas actuales.

## Fuente precisa de la aceptación

En conversación, el asistente recomendó explícitamente tres comportamientos para la Gallery virtualizada:

1. **Seleccionar todo:** seleccionar **todos los beats que coinciden con los filtros**, no únicamente los renderizados; mostrar la cantidad.
2. **Siguiente/anterior/Shuffle:** operar sobre **todos los resultados de la búsqueda**, aunque no estén cargados; la cola manual tiene prioridad.
3. **Barra de tags:** mostrar **tags de toda la biblioteca** y mantenerlos estables durante scroll; renombrar un tag afecta **todas sus apariciones**.

El usuario respondió **«apruebo»** a esos tres puntos. Por tanto los tres comportamientos funcionales quedan aprobados; no se infiere aprobación para opciones, límites o políticas no incluidas en esa pregunta.

La aprobación complementa [C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md) (experiencia scroll infinito ya aprobada). Reemplaza el estado pendiente de **STOP-INTERACTION-SELECTION**, **STOP-INTERACTION-QUEUE** y **STOP-INTERACTION-TAGS** respecto **al alcance de producto**; su diseño/implementación siguen requiriendo pruebas, criterios de seguridad y solución técnica. NO equivale a C12 global PASS.

## I1. Selección global del conjunto filtrado — APROBADA

- «Seleccionar todo» representa exactamente el conjunto de resultados de la consulta global actual (tenant autenticado, filtros, estado, revisión), incluso si hay 100.000 beats. La UI muestra la cantidad; no dice «todos» cuando solo conoce el viewport o una página.
- La selección individual debe sobrevivir al desmontaje y remontaje de una BeatCard; no podarla al expulsar bloques de caché.
- **Arquitectura recomendada, no decisión numérica:** token/contexto de selección firmado y acotado, con exclusiones por identidad y snapshot/revision; no descargar ni guardar 1M IDs en navegador. El backend valida auth/tenant, versión, filtros, estado y revisión antes de actuar. No interpretar una selección de un tenant en otro.
- Operaciones bulk respetan **máximo 50 beats por lote** del contrato existente, con progreso, cancelación y resultado por lote explícitos; selección global no autoriza una transacción enorme ni reportar éxito parcial como total. Si cambia el conjunto por ediciones concurrentes, pedir revisión/mostrar conflicto, no aplicar silenciosamente a un resultado nuevo.
- Detallar la semántica visible de «deseleccionar todo», inclusión/exclusión individual después del select all y filtros cambiados, y probarlas en V07/T14 antes de activar; preferir fail-closed a selección sobre otra query.
- Mantener UI y gestos actuales (incluida selección por Shift) con equivalencia definida para rangos fuera de ventana; un índice relativo a `windowItems` NO define el rango global.

## I2. Reproducción y navegación musical global — APROBADA

- **Next, Previous y Shuffle** recorren el conjunto de beats de la **búsqueda/filtros globales**, independientemente de cuáles DTO estén residentes o qué BeatCards estén montadas.
- **Cola manual/explícita primero**, sobre la navegación automática del conjunto. Mantener repeat, seek, Playbar y reproducción al hacer scroll: sacar una tarjeta o su DTO de ventana no detiene audio ni elimina IDs de la cola.
- PlaybackSession conserva identidad, versión y referencia activa de fuente con propiedad independiente del grid. Resolver siguiente beat a través de una consulta acotada, no por `displayedBeats`/array de una ventana ni `ORDER BY random()` sobre la biblioteca completa.
- **Pendiente técnico de V00/V06/T14** (no cambiar el alcance aprobado): fijar qué ocurre con la secuencia en reproducción cuando el usuario cambia filtros/orden después de pulsar Play, distribución de Shuffle, reglas de repetición al agotar los resultados y qué sucede si se borra un beat fuera de ventana. Documentar alternativa preferida con pruebas; si ocasiona una diferencia de UX no cubierta, presentar esa diferencia antes de implementarla.
- En todo caso preservar prioridad de cola explícita y no introducir interrupciones por scroll/evicción.

## I3. Tags y renombrado global — APROBADOS

- La Tag Bar muestra **el universo de tags de la biblioteca**, no solamente los tags de los bloques visibles. Debe permanecer estable al navegar hacia abajo/arriba; solo cambia cuando cambian realmente los tags o el contexto autenticado.
- Incluir tags activos aunque no aparezcan en un bloque visible. Respetar identidad exacta, estados include/exclude, orden/colores y gestos de Tag Bar existente; no redefinir filtro ANY/exclusión por usar facetas SQL.
- Renombrar una etiqueta afecta **todas sus apariciones dentro de la biblioteca autorizada**; jamás limitarlo a los beats cargados ni declarar éxito si solo se alteró la ventana. Preservar la semántica de metadatos, cuotas, referencias, versiones, conflictos y operaciones de restore/trash según alcance que se verifique con código/T01.
- **Arquitectura recomendada, no presupuesto medido:** enumeración de facetas globales con consultas SQL, resultados/caché acotados y actualización por revision; si hay gran cantidad de nombres de tags, virtualizar/paginar también la presentación horizontal sin perder búsqueda o tags seleccionados. No descargar cientos de miles de etiquetas solo para pintar la barra.
- Renombrado global requiere idempotencia y control de concurrencia, reporte exacto y recuperación ante fallo. No convertir una operación masiva en loop no acotado del navegador ni leer/reescribir el INDEX completo.

## Interacciones y pruebas obligatorias

- **I1:** 100.000/1.000.000 beats sintéticos, filtro que coincide fuera de los primeros 240, select all, exclusiones, Shift entre bloques, cambios de filtro/revisión/cuenta, bulk 50 por lote y resultados parciales explícitos.
- **I2:** reproducir beat fuera de ventana, scrollear hasta evict, Next/Previous en frontera y tras evict, Shuffle con distribución/método justificados, cola manual por delante, repeat, seek, account switch y fallo/timeout.
- **I3:** tag presente solo en beat 241, tag activo persistente tras desplazarse, universo global estable, colores/duplicados/case, rename de múltiples beats y error a mitad, tenant/generation/epoch, restore/trash, perf de facetas.
- **General:** los stores y contadores no escalan linealmente con N; no falsear empty/no-results al fallar SQL; no llamadas Telegram/MASTER para metadata de autoridad POSTGRES. Tests/benchmarks futuros, no ejecutados por esta aceptación.

## Integración segura con el checkout de la IDE

La IDE mantiene un checkout LOCAL en `a446219` con **C12-r2**, `C12-CARACTERIZACION-20261107.md` y el plan **C12-r3 / B-scroll-v1** (`C12-B-INTEGRACION-Y-PLAN-20261107.md`) con modificaciones locales **no publicadas**. No sobrescribir esos documentos al hacer pull de `origin/local/landing-gallery-unificada`. En GitHub la rama posee este nuevo anexo como añadido independiente.

Pasos para IDE: proteger/commit de docs locales o worktree, revisar diff/ancestría, integrar este anexo en el acta r3 y el V00 del plan granular, actualizar `ESTADO.md`, `EVIDENCIA.md`, `CONTRATO.md` y `TAREAS.md` dentro de docs; conservar literalmente la caracterización y sus experimentos, además de los archivos ajenos sin seguimiento. No hacer `reset --hard`, `git clean` ni merge que pierda trabajo.

## Estado de gates después de esta aprobación

| Decisión | Estado |
| --- | --- |
| B-experiencia (scroll infinito virtualizado, query global) | **APROBADA** |
| I1 selección de todos los resultados | **APROBADA** |
| I2 reproducción/Shuffle global + cola manual prioritaria | **APROBADA** |
| I3 facetas globales estables y rename global | **APROBADA** |
| A1 Unicode orden fijo | **PENDIENTE de registro de aceptación explícita conforme a C12-r2** |
| A2 BPM inválidos | **PENDIENTE de registro de aceptación explícita conforme a C12-r2** |
| B-legacy `bgPage`, límites/avisos/acción inicio | **PENDIENTE** |
| C12 general, T00 y G0 formal | **NO PASS** |
| T01/T02 | **NO INICIADAS** |

**No implementar** el runtime ni iniciar T01/T02 por este documento. Es exclusivamente una decisión de producto para que la IDE concluya el diseño y su matriz de pruebas.
