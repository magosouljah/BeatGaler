# C12-B — Gallery infinita virtualizada (decisión de producto)

Fecha: 2026-11-07. Rama exclusiva: `local/landing-gallery-unificada`.
**Aprobación de producto:** el usuario pidió expresamente una sola Gallery continua, sin páginas visibles; al bajar, las BeatCards de arriba dejan de estar montadas y las de abajo se cargan. Confirmado con «perfecto» y «ok». Este documento registra esa decisión **sin autorizar implementación**.

**Precedencia:** esta decisión sustituye la navegación visible por páginas de C12-r2 §5.1–5.3 para bibliotecas con autoridad POSTGRES, y la propuesta previa de conservar botones Previous/Next como experiencia principal. No reemplaza los invariantes de C1–C11. La caracterización C12-r2 y evidencia local generada por la IDE permanecen como base técnica no subida; integrarlas sin perder sus cambios.

## 1. Contrato UX aprobado

- **Una sola vista Gallery con scroll vertical continuo**: no mostrar números de páginas, botones anterior/siguiente ni saltos/reloads para cargar bloques en bibliotecas POSTGRES.
- **Virtualización efectiva por filas**: conservar en DOM solo tarjetas visibles y un overscan pequeño; las tarjetas alejadas salen del árbol React y se liberan recursos de artwork/hover/observadores. Mantener altura fija de BeatCard, separación, anchura/márgenes, diseño de Toolbar/Tag Bar/Playbar exactamente como en LOCAL. Altura/cant. de columnas y padding se miden en el contenedor real; no hardcodear «4 columnas» ni cambiar la apariencia para simplificar.
- **Carga anticipada**: solicitar el siguiente bloque antes de llegar al extremo visible; permitir volver hacia arriba sin perder continuidad ni repetir filas; usar caché **acotada** de bloques con LRU/evicción y rehidratación controlada. Nada de cargar N beats en memoria o montar 100.000 BeatCards al hacer scroll.
- **PostgreSQL aplica globalmente búsqueda, tags y orden** ANTES de paginar internamente; solo envía datos acotados. Los resultados de `q`, ANY/exclusión, `manual/name/bpm/rating` son globales; no repetir `selectFilteredAndSortedBeats` sobre el subconjunto visible una vez en modo POSTGRES.
- **Scroll sin brincos**: mantener espacio con virtualización y claves estables; respetar la misma posición visual al desmontar/remontar filas, al cambiar ancho/columnas y al entrar/salir de detalles cuando los resultados siguen vigentes.
- **Cambiar búsqueda/filtros/orden** inicia un nuevo conjunto lógico y vuelve al principio de resultados; aborta/ignora peticiones obsoletas, conserva predicados y la preferencia sort. Estado cargando, sin coincidencias, offline, error y revisión obsoleta deben diferenciarse; nunca interpretar un fallo como biblioteca vacía.
- **Audio y Playbar** no dependen del montaje de una BeatCard: que la tarjeta de la canción en reproducción salga de pantalla NO detiene playback, seek, cola ni cambia artwork/routing. Menús y hover no sobreviven montados fuera de vista; estado de selección/edición se guarda por ID en un store estable, no en la instancia de tarjeta.
- **Accesibilidad/interacciones**: teclado/focus, scroll nativo, edición, menú, drag de archivos, selección y tags deben conservarse. El drag-reorder manual requiere diseño específico compatible con filas virtuales: nunca pasar todos los 100.000 IDs a `SortableContext` ni cambiar orden global por un drag limitado a la ventana. Si no es posible con seguridad, STOP-DESIGN de esa interacción concreta antes de activar POSTGRES.
- **Sin paginación visual no significa sin páginas internas**: backend usa keyset, cursores firmados por tenant/generación/época/revisión/filtro/sort y bloques limitados por contrato C5; DOM y caché de resultados se mantienen acotados. El usuario puede recorrer de inicio a fin aun con 100.000 beats.

## 2. Contrato de carga y límites a verificar

- API default 100, límite 240 conforme a C12-r2; son tamaños de bloques internos, NO «240 por página» visible.
- Definir en diseño tamaño inicial/overscan/prefetch/eviction según viewport, filas y memoria medida; **no inventar un número fijo de tarjetas en DOM como si ya estuviera medido**. Perf obligatorio con 100k/1M filas sintéticas, scroll rápido arriba/abajo, consultas fuera de orden, caché fría/caliente, resizing y móvil/desktop donde soporte el producto.
- Backward scrolling después de evicción: recuperar bloques anteriores por cursor o reanclar en SQL; no volver a consultar el INDEX completo ni recorrer infinitamente todos los cursores para llegar a la posición antigua. El servidor no debe retener transacciones durante scroll.
- Minimizar requests repetidos, imágenes concurrentes y renders de layout. La virtualización debe usar un solo scroll container: `[data-library-scroll="true"]` en `src/app/AppShell.tsx:288–292`. Las dimensiones reales de `.lab-gallery-grid` y de BeatCard se auditan antes de elegir el motor.
- No crear una lista virtual distinta para producción `main`, DESIGN ni Desktop. Primero implementación futura LOCAL tras gates.

## 3. Enlaces antiguos bgPage — compatibilidad, no interfaz

El formato `?bgPage=240` es un offset legacy, no un número de página. Para bibliotecas LEGACY, su comportamiento se conserva hasta el corte. Para bibliotecas POSTGRES, intentar traducirlo una sola vez a ancla/posición en el nuevo **orden global**, y desplazar la única Gallery a esa posición si se puede resolver con costos acotados. Un enlace antiguo puede acabar sobre un beat distinto porque el nuevo orden y filtro son globales.

**Aún NO aprobado en detalle:** el límite propuesto de 10.000 para resolver offsets antiguos, los mensajes/avisos, y el destino de enlaces profundos no recuperables; estos son asuntos de compatibilidad B-legacy. No presentar una cota arbitraria como decisión del usuario. Recomendación: resolver si está dentro del presupuesto; si no, mostrar estado explícito y acción elegible «Ir al inicio», sin salto silencioso, sin error de «biblioteca vacía» y sin generar decenas de miles de solicitudes.

No mostrar el antiguo paginador aunque el enlace tenga bgPage. Mantener ruta/hash/cuenta/auth; invalidar/revisar scroll anchor y cursor al cambiar tenant, época, revisión o sort. Los enlaces nuevos pueden representar filtros y ancla opaca segura; no prometer bookmarks con scroll exacto a través de mutaciones de catálogo.

## 4. Código actual y riesgos concretos

Inspección de la rama remota antes de este anexo:
- `src/app/AppShell.tsx:288–389`: `[data-library-scroll]` con `overflowY:auto`; lista renderiza **todos** los `filteredBeats` en `BeatCard` y pasa **todos** sus IDs a `SortableContext`; este camino no es virtualizado.
- `src/app/WebGalleryWorkspace.tsx:1–9`: monta `WebLibraryPagination`; deberá ocultarse/removerse **solo para modo POSTGRES** cuando se implemente el nuevo contrato. LEGACY continúa protegido.
- `src/features/library/webLibrary.ts:13,238–316` y `webLibraryWindow.ts`: normalizan INDEX y materializan página bounded mediante offset; **no son el motor SQL** de una Gallery virtualizada.
- `src/features/library/librarySelectors.ts:4–33`: filtros y sort sobre array materializado; en modo POSTGRES el servidor debe ser autoridad de resultado global.
- `src/components/BeatCard.tsx`: contiene estado/efectos propios (artwork, hover, menus); la virtualización exige limpieza y estado externo por ID donde corresponda.
- `src/features/library/useLibraryReorder.ts:14–49`: reordenación local con arrayMove, Tauri; revisar compatibilidad Web, DnD y ventanas.

## 5. Criterios de aceptación futuros

1. Con 100k/1M beats de prueba, DOM de tarjetas y memoria NO crecen linealmente con toda la biblioteca; registrar cifras, no solo observación visual.
2. Scroll continuo en ambos sentidos, sin duplicados, huecos, saltos de posición ni pérdida de foco cuando las filas entran/salen.
3. Búsqueda/tag/sort global muestra resultados incluso si todos están después del beat 240 inicial.
4. Playback, range/seek, cola y Playbar continúan cuando la tarjeta activa queda fuera de vista; artwork y menús no fugan listeners/objetos.
5. Resize, cambios de columnas, carga de imágenes, edición/restore/trash mientras se hace scroll, cursor stale, cambio de cuenta y errores controlados no corrompen la posición ni mezclan datos de tenants.
6. Los bookmarks `bgPage` legacy no activan interfaz de páginas y nunca provocan barrido sin límite.
7. El modo LEGACY conserva la experiencia actual hasta migración autorizada; no modificar `main`, producción ni DESIGN.
8. Perfil C11 con EXPLAIN/p95/p99/RSS, incluyendo scroll rápido, backtracking y caché; no declarar PASS sin medición real.

## 6. Gate y estado

- **B-experiencia principal: APROBADA por producto** (scroll infinito virtualizado + consulta global).
- **B-legacy: PENDIENTE** de política de enlaces antiguos y límites con evidencia.
- **A1 (nombre Unicode) y A2 (BPM inválidos):** no declarar cerradas por este anexo; reflejar el acta local C12-r2 y sus aceptaciones reales.
- T00 baseline 68/68 PASS, probe PG16.15 PASS; **C12 global NO CERRADO; G0 NO APROBADO; T01 NO INICIADA**.
- **Este commit solo añade documentación.** No implementa UI, API, migraciones, índices ni tests de catálogo.
