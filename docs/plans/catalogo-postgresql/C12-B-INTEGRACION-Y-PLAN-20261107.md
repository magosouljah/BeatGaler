# C12-B — Integración segura y plan de Gallery continua

**Vigencia C12-r4 (2026-11-07):** [cierre C12-r4](C12-V00-CIERRE-20261107.md) integra el [acta I1/I2/I3 aprobada](C12-V00-INTERACCIONES-APROBADAS-20261107.md) de `c6d7b7cf4455623ab2da7bfbdadabb0b4b3e3b81` y las respuestas explícitas del usuario de este encargo. **A1/A2/B-legacy e I1/I2/I3 aprobados; decisiones C12/V00 cerradas para diseño.** Shuffle sin repetición por ronda, aviso de selección solo si existía y rename también en papelera sin alterar su estado. Las menciones pendientes r2/r3 quedan como antecedentes, sustituidas por r4. **T00/G0 no PASS; T01 bloqueada; T02 no iniciada.** No hay autorización de implementar.


Fecha: 2026-11-07. Base **C12-r3 / B-scroll-v1**, integrada por C12-r4. Solo documentación; ningún paso de implementación iniciado.

## 1. Autoridad, protección y reconciliación

La [decisión oficial de producto](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md), incorporada sin cambios desde `b585540a3a82bc8604d8d6de603514af48b5feb4`, aprueba **una sola Gallery POSTGRES con infinite scroll virtualizado**, resultados globales y desmontaje efectivo. No aprueba por extensión el límite10.000, copy ni destino de enlaces antiguos. A1/A2 siguen pendientes. C12/T00/G0 no pasan por este anexo; T01/T02 siguen cerradas.

Base runtime inspeccionada: HEAD local `a4462191aea29ffdae136f04e1fdc2e4024291d1`, rama `local/landing-gallery-unificada`. Remoto obtenido: `origin/local/landing-gallery-unificada` = `b585540a3a82bc8604d8d6de603514af48b5feb4` (cinco commits por delante). No se hizo merge, pull, checkout ni commit; HEAD permanece local. Diff de producto entre ambos vacío. No se encontraron AGENTS.md aplicables en ancestros/inventario.

Antes de editar:

1. Se inspeccionaron status, branch y log−3. Los cinco MD modificados y dos MD C12 nuevos correspondían al trabajo local anterior; `Claude outputs/` y `beatgaler-console.jpg` eran ajenos/preexistentes.
2. `git fetch origin` falló por refspec configurado a `release/0.9.0-beta.2`, rama remota inexistente. No se cambió configuración. Se ejecutó fetch explícito de `refs/heads/local/landing-gallery-unificada` hacia su remote-tracking ref, con éxito.
3. Se protegió el directorio completo en `E:\777\app\BeatGaler-c12-document-backups\20261107-185609-a446219\catalogo-postgresql`, con `manifest.json`: SHA/branch/status,15 archivos, tamaños y SHA256. Se verificaron **15/15 hashes y coincidencia con originales antes de editar**.
4. En la misma copia se guardó `remote-b585540a/`:19 archivos del directorio remoto y `hashes.json`. Incluye su acta C12 abreviada; no reemplaza r2.
5. Se incorporaron textualmente los cinco MD nuevos remotos: anexo B, handoff B, prompt maestro G0, laboratorio G0 y probe verificado. Se integraron las adiciones append-only de ESTADO/EVIDENCIA/TAREAS/T00-REVISION como **historial remoto**, contrastadas con base común. Se conserva la caracterización local intacta y el contenido técnico r2 más completo.
6. No se incorporaron el workflow ni el cambio de runner `.ps1`: este encargo solo integra documentación. La rama local **no está sincronizada integralmente con origin**. Un futuro commit/merge debe comparar estos blobs y no reemplazar actas vigentes por antecedentes; ambos snapshots permiten reconstruir la reconciliación.

Restauración de documentos si hiciera falta: comparar hashes y copiar únicamente archivos nominados desde la copia local a un destino nuevo de revisión. No restaurar todo el árbol ni sobrescribir trabajo posterior por defecto. No se necesitó restaurar en este encargo.

## 2. Hechos del runtime que determinan el diseño

Se agregan a E01–E14 de [caracterización r2](C12-CARACTERIZACION-20261107.md). Son lectura estática sobre HEAD local, no mediciones de una Gallery montada.

| Ref. | Archivo/líneas | Consecuencia verificable |
| --- | --- | --- |
| V01 | `src/app/AppShell.tsx:288–389` | Un scroll container `data-library-scroll=true`, overflowY auto; filteredBeats.map monta todo el bloque, SortableContext recibe todos sus IDs. `visible=false` oculta una tarjeta, **no la desmonta**. |
| V02 | `AppShell.tsx:527–550`; `src/app/useBeatGalerComposition.ts:639–673` | Player se monta solo si currentBeat existe; currentBeat=beats.find(playingId). SelectedBeats también se deriva de beats. Evicción ingenua puede quitar Player/seleccionados. |
| V03 | `src/features/playback/usePlaybackQueue.ts:29–45,48–118` | Quita queueIds ausentes; llama releaseFile si playingId no existe en beats; next/prev/shuffle dependen de displayedBeats o beats. Desmontar tarjeta y expulsar DTO no son eliminación autorizada. |
| V04 | `src/features/selection/useBeatSelection.ts:17–83` | Ancla es índice relativo; shift usa slice local, Select All usa displayedBeats y efecto poda IDs no cargados. No reutilizar esa poda en catálogo. |
| V05 | `src/features/design/GALLERY/product-gallery.css:4–10`; `gallery.css:19–26,104–125,383–388` | Altura declarada239px; tile160px; columnas CSS7→6→5→4→3→2→1, gaps22/28,15/24,13/22. Padding superior deriva de tokens; fondo cambia con Player. **Son declaraciones**, no geometría renderizada certificada. |
| V06 | `src/components/BeatCard.tsx:85–105,145–157,187–258,267–312,343–405` | Estado hover/menús; listeners globales; dos setTimeout que añaden listener sin guardar handle en ese efecto; IntersectionObserver y warmup por montaje; transform local. Remontajes repetidos exigen cleanup y deduplicación por entidad/versión. |
| V07 | `src/features/startup/useLibraryReveal.ts:37–132`; `artwork/useArtworkHydration.ts:19–88` | revealedBeatIds crece; hydration guarda promesas exitosas en Map y mete base64 en beats. No reutilizar como cache de toda la sesión infinita. |
| V08 | `src/features/playback/usePlaybackController.ts:37–151`; `state/useBeatRuntimeRegistry.ts:56–92` | Caches de URLs/promesas y pruning por array; hay que separar vida de operación/audio de vida de ventana. |
| V09 | `src/platform/webAdapter.ts:72–79,177`; `playback/webVisiblePlaybackPrefetch.ts:65–112` | Registry acumula beats recordados; observadores miran document y descubren añadidos, cleanup global. En virtualización deben registrar y retirar nodos individuales; WeakMap por sí solo no demuestra que observer suelte nodos. |
| V10 | `src/app/useBeatGalerComposition.ts:63–118,124–127,158–174,193–212,291,381,624–627` | LibraryState es array materializado (actualmente hasta240 en Web); muchos hooks lo tratan como conjunto completo. No sustituirlo por concatenación creciente ni por viewport sin adaptar consumidores. |
| V11 | `src/features/library/useLibraryState.ts:16–47,49–81`; `useLibraryReload.ts:98–126` | Cache localStorage del array y refresh de snapshot; POSTGRES requiere contexto/query/ventana y no esta autoridad legacy. |
| V12 | `src/features/design/GALLERY/GalleryChrome.tsx:13–38`; `tags/useTagRename.ts:28–33,71–93` | Tag Bar consume allTags local; rename cuenta y recorre beats. No convertir «global» en renombrar solo DTO residentes ni informar alcance falso. |
| V13 | `src/platform/capabilities.ts:57–80`; `AppShell.tsx:351`; `library/useLibraryReorder.ts:23–47` | **Web manualLibraryReorder=false**. Mantenerlo: no introducir reorder nuevo, SortableContext masivo ni endpoint de reordenamiento. Drag de archivos sí es una capacidad Web distinta. |
| V14 | `src/app/WebGalleryWorkspace.tsx:4–8`; `WebExperience.tsx:14–26` | Pager y App se montan hoy juntos, Workspace post-auth; GalleryChrome importa CSS desde DESIGN compartido. La integración futura usa modo autoridad y CSS scoped, sin modificar DESIGN para hacerla funcionar. |

No hay dependencia de virtualización en package.json/package-lock inspeccionados. React ^18.3.1 declarado, dnd-kit ya presente; ninguna dependencia se instaló. No se revisó ni modificó producción/main.

## 3. Arquitectura decidida para implementar después del gate

**Elegir virtualizador aritmético de filas fijas**, específico del contrato actual; sin agregar librería en esta entrega. Razón: tamaño fijo y columnas observables permiten computar rangos sin arrays de N medidas. Cualquier alternativa que se proponga luego debe demostrar costo de memoria independiente de N antes de reemplazar este diseño; no introducir masonry o alturas variables. Si medición real desmiente altura fija, STOP-LAYOUT para alta capacidad, no improvisar otro motor.

Flujo: contexto/auth → query global SQL → store de bloques acotado → rango de filas → BeatCards montadas. En paralelo, sesión de playback, selección y editor poseen identidades/estado fuera de las tarjetas. Un scroll no muta selección, cola ni reproducción.

Módulos nuevos propuestos (no existen todavía):

| Módulo futuro | Responsabilidad / prohibición |
| --- | --- |
| `src/features/library/catalog/catalogQueryStore.ts` | Contexto, queryGeneration, abort/singleflight, bloques bidireccionales, evicción, estado de carga; nunca toda la biblioteca |
| `catalogRowGeometry.ts` | Funciones puras de filas/columnas/origen/anchor, O(1) para límites y O(filas montadas) para render |
| `useCatalogVirtualRows.ts` | Un ResizeObserver de geometría, listener scroll pasivo y rAF; calcula rango, conserva anchor y gestiona foco |
| `CatalogVirtualGallery.tsx` | Render de filas con claves estables, placeholders acotados y estados; utiliza el contenedor de AppShell, no crea segundo scroller |
| `catalogNavigation.ts` | Cursores/anclas/URL/query, historial bounded y compatibilidad bgPage; no location.assign para bloques |
| `catalogInteractionStore.ts` | Selección/drafts/focus/modal refs por cuenta/ID/version; ninguna poda por evicción |
| `src/features/playback/catalogPlaybackSession.ts` | CurrentBeat y rutas fijadas por versión, cola explícita y contexto de navegación musical independientes del grid |
| `src/features/library/catalog/catalog-gallery.css` | Solo selectores `.bg-product-gallery[data-catalog-mode=postgres]`; geometría de filas virtuales, no cambios de tokens, tamaño ni DESIGN |

Usar store por Workspace/cuenta, suscripciones con `useSyncExternalStore` y snapshots inmutables estables, no singleton con datos de todos los usuarios. El snapshot debe mantener identidad cuando no cambió; subscribe limpia suscripción. [Contrato React](https://react.dev/reference/react/useSyncExternalStore). No convertir cada evento de progreso de audio en rerender del grid completo.

**Punto exacto donde desaparece el supuesto de array completo:** al resolver contexto POSTGRES, el adaptador de composición usa CatalogQueryStore. `useLibraryState` y su `setBeats`, fingerprints/reload/cache global quedan exclusivamente en rama LEGACY/Desktop. No invocar hooks condicionalmente en el mismo componente: extraer providers/componentes de composición por autoridad con API común para AppShell; todos los hooks de cada provider se llaman establemente. Cambio de autoridad requiere remontaje controlado del provider tras invalidación; no fallback automático.

`windowItems` = DTO residentes; `renderItems` = filas virtuales; `visibleItems` = intersección real viewport; **ninguno representa todos los resultados**. Solo cuentan como resultados globales count y query del servidor. No exponer un alias engañoso `allBeats=windowItems` a funciones que puedan escribir una biblioteca entera.

## 4. Geometría y scroll anchor

### Medir sin cambiar el diseño

V03 de la lista de tareas deberá montar fixture de Gallery LOCAL con dobles, en navegador, sin auth real/Cloud. Leer getComputedStyle del track `.lab-gallery-grid`: columnas efectivas, columnGap, rowGap, padding y ancho útil; medir border-box de BeatCard sin transform hover (offsetHeight o ResizeObserver borderBoxSize, no el rect movido). Observer del scroller, track y una tarjeta patrón de las filas montadas. Registrar viewport, DPR, zoom, fuentes cargadas y barra de scroll. [ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver).

CSS declara altura239 y width160; usarlos solo como **estimación inicial** para skeleton con comprobación inmediata. Leer columnas desde grid-template-columns resuelto; no duplicar breakpoints en JS ni calcular cuatro columnas fijas. Esperar document.fonts.ready para baseline de medición; antes conservar anchor al corregir estimación. Columnas cero/NaN, ancho insuficiente o alturas dispares >1 CSSpx → STOP-LAYOUT, sin recortar contenido ni cambiar CSS base.

Sea C columnas, H altura medida, G rowGap, P=H+G, V alto útil, ordinal i del resultado. Fila global `floor(i/C)`, columna `i%C`. El contenedor mide la separación real desde inicio del track; el toolbar flotante y padding no se contabilizan dos veces. Última fila parcial alinea con las mismas columnas del track completo (no centrar sus tarjetas como otro grid).

Renderizar wrappers de fila `role=presentation` con top/altura explícitos dentro de un track de altura reservada; CSS grid de cada fila usa las mismas tracks/gaps medidos. Clave de tarjeta `(tenant,beatId)` y fila `(queryGeneration,C,globalRowIndex)`. Layout de fila no debe anular transform/hover de tarjeta ni recortar menús. No usar content-visibility o visibility:hidden como sustituto de desmontaje.

### Anchor y operaciones

Anchor estable `{queryKey,revision,beatId,ordinal,intraRowPx,viewportOffsetPx,columns,focusTarget}`; también boundary firmada del bloque que lo contiene. Elegir primera tarjeta visible estable, salvo foco de teclado activo. Valor relativo al área útil del **mismo** scroller.

1. Antes de prepend/evict/resize/layout: capturar posición de anchor y contexto.
2. Actualizar bloques/filas y origen físico en una sola transición; renderizar filas y espaciadores de alturas exactas.
3. En layout effect antes de paint, localizar anchor por ID/ordinal vigente y ajustar scrollTop por diferencia entre posición nueva y anterior. Sin smooth scrolling durante compensación. La resta considera padding/Player/Tag Bar si cambia área útil.
4. Desactivar `overflow-anchor` únicamente en scroller/track POSTGRES controlado para evitar compensación doble del navegador. Este control se verifica por navegador, no se presume universal a partir de la especificación. [CSS Scroll Anchoring, borrador](https://drafts.csswg.org/css-scroll-anchoring-1/).
5. Cambio de columnas: conservar beatId y offset vertical; recalcular `floor(i/Cnuevo)` sin cambiar orden ni pedir otra búsqueda; completar fila limítrofe desde bloque vecino. No ordenar por filas antiguas.
6. Artwork placeholder→imagen conserva H, no requiere desplazamiento. Hover −2px es visual, no medida de fila. Mostrar/ocultar Player cambia padding inferior; no debe mover primera tarjeta visible.
7. Detalle/edit: guardar un solo returnAnchor y draft independiente. Al cerrar con misma revisión/query/cuenta, rehidratar bloque por cursor si fue expulsado y restaurar foco/offset. No fijar todas las tarjetas de una página mientras modal está abierto. Si cambió revisión, no afirmar pixel perfecto; usar política stale de sección7.

### Altura física acotada, sin millones de espaciadores

Decisión: track representa **intervalo contiguo residente**, con como máximo un bloque placeholder anterior y uno posterior cuando hay más datos. No reservar `ceil(N/C)*P` en CSS ni un array de N rows. Esto evita depender de límites de altura del navegador para1M resultados. Se conserva ordinal global y un `originRow` móvil; top de fila=`(globalRow−originRow)*P` más padding del track.

Al expulsar bloques extremos, mover originRow y scrollTop por exactamente las filas retiradas, preservando anchor. Al recargar hacia arriba, operación inversa; no reset al primer beat. La barra nativa describe el tramo representado, **no porcentaje de toda la biblioteca**; esta es consecuencia de diseño de ventana móvil, no una medición ni una promesa de scrub global. Si se exige thumb proporcional a N o saltar por arrastre a cualquier ordinal, STOP-LAYOUT/NAV: requiere búsqueda por ordinal/index adicional, no OFFSET ilimitado.

Evicción solo de filas completas.240 no es múltiplo de7: conservar como máximo2(C−1) DTO de borde para completar las filas que atraviesan límites de bloque; son parte del presupuesto. Cursor anterior/siguiente siempre procede del bloque original firmado. Rehidratarlo puede repetir esos DTO de borde; deduplicar por contexto+ordinal+ID y verificar versión igual, no crear espacios duplicados. Un ID distinto para el mismo ordinal/revisión → STOP-INTEGRITY.

El usuario puede desplazar más rápido que la red: alcanza placeholder de la frontera, nunca un agujero tratado como vacío. La carga se solicita automáticamente; si falla, conserva posición y ofrece reintento contextual sin controles de página. No simular datos ni hacer scroll automático hasta el borde siguiente.

## 5. Ventana, memoria, cursores y prefetch

Parámetros iniciales de ensayo, **no cifras ya medidas**:

| Recurso | Presupuesto de diseño |
| --- | --- |
| Bloque interno |240 DTO inicialmente; API conserva default100/max240 |
| Residentes |Máximo6 bloques /1.440 DTO, más ≤2(C−1) bordes; bytes serializados metadata≤12 MiB para bloques |
| Peticiones metadata |Máximo2 en vuelo, una por dirección; una promesa por cursor/query; ninguna cola de prefetch ilimitada |
| Memoria transitoria |Hasta2 respuestas entrantes de2 MiB adicionales, contabilizadas; liberar referencias anteriores al confirmar evicción |
| Overscan |O=min(8,max(2,ceil(ceil(V/P)/2))) filas por lado; fórmula provisional ligada a viewport |
| DOM |≤C×(ceil(V/P)+2O+2+1fila foco) tarjetas; rango recortado a existentes. No afirmar un número fijo medido |
| Prefetch |Comenzar a2 viewports del borde, ajustar entre1 y3 con velocidad y latencia observadas; descargar un bloque vecino, nunca en bucle hasta N |
| Artwork |4 solicitudes concurrentes, prioridad visibles→overscan; LRU por bytes con objetivo32 MiB decoded estimados, no imágenes de todos los residentes |
| Retornos/historial en store |Un returnAnchor de detalle y hasta16 entradas de navegación; no mantener cursor por cada bloque visitado |

LRU restringido a **extremos** de la ventana contigua: proteger bloques que contienen viewport+overscan, elegir extremo más antiguo fuera de protección. No expulsar un bloque intermedio dejando hueco. Focus/editor/audio guardan sus propios objetos/ref, no fijan indefinidamente un bloque entero. Si viewport+overscan no cabe en seis bloques, STOP-BUDGET en prueba del viewport soportado; no aumentar caché sin registro y remedición. Bytes JS/DOM/decodificados no equivalen a bytes JSON: medir heap/RSS aparte.

Inicio: cargar bloque SQL del query/anchor; representar solo viewport y overscan. Bajo viewport alto, cargar secuencialmente lo necesario hasta llenar viewport+overscan respetando budgets, no asumir siempre240 suficientes. Append/prepend se valida antes de publicar: tenant,era,epoch,generation,revision,query hash,sort profile,startOrdinal,IDs y fronteras. Queries fuera de orden o abortadas se descartan por `requestGeneration`, aun si fetch abort no impidió la respuesta.

Scroll hacia atrás tras evicción usa **previousCursor de la frontera residente**; una carga por bloque requerido. Se preservan solo cursores de los bloques actuales y sus dos extremos; no cadena de miles de tokens. Al volver desde detalle/historial, cursor inclusivo de reapertura del bloque carga directamente; no recorrer desde inicio. Una ancla vieja no justifica usar un cursor de otra revisión.

API r2 sigue con keyset+HMAC contextual y limit+1. Mantener prev/next **solo como protocolo interno**, no botones. Añadir `resumeCursor` a la respuesta y usar `GET /catalog/v1/beats?...&cursor=<resumeCursor>` para reabrir boundary inclusiva y devolver bloque240 con ordinal/count del mismo snapshot; no crear otro endpoint para el mismo caso. Token propio/auth/filters/version obligatorios; no aceptar ordinal arbitrario de cliente como sustituto. T06 fija la ruta exacta antes de cliente; si hace falta reanclar por ID en revisión nueva, debe justificar costo SQL/COUNT antes del anchor y timeout con EXPLAIN, o aplicar stale sin intentar una búsqueda ilimitada.

No reusar WebLibraryWindowConsumer como backend SQL: su contrato normaliza INDEX y offsets, y su refresh no conoce queryGeneration ni evicción. Conservarlo en LEGACY. Tampoco hacer INDEX→SQL aparente con selector local sobre240: servidor filtra/ordena antes de LIMIT; cliente dibuja orden recibido.

## 6. Adaptación por módulo y límites de vida

| Componente/hook actual | Modo POSTGRES futuro | Modo LEGACY/Desktop |
| --- | --- | --- |
| AppShell grid y empty states | Contenedor existente + CatalogVirtualGallery; estado vacío depende de respuesta SQL exitosa, no windowItems.length ni Direct | Mantener implementación actual |
| WebGalleryWorkspace | Context provider post-auth; montar pager solo si autoridad LEGACY, nunca durante context unknown ni por bgPage POSTGRES | Pager actual conservado |
| webLibraryWindow/webLibraryNavigation | Adaptador catalog separado, blocks/anchor/abort/queryGeneration; no reset ni offsets como navegación principal | Sin alteración de semántica heredada |
| librarySelectors/useLibraryViewState | Search/sort producen query global; no volver a filtrar/sort local. Vista conserva preferencia sort | Selector actual permanece |
| useLibraryState/useLibraryPresentationCache/useLibraryReload | Cache por cuenta/era/query y bloques; refrescar contexto/query con límites, no guardar todo lo visitado en localStorage | Ruta actual de snapshot/cache |
| useLibraryReveal/useArtworkHydration | Solo cards montadas+overscan; estado load/error por fileVersion, límites y cancelación. Metadata aparece sin esperar audio/artwork | Flujo heredado |
| BeatCard | Mantiene diseño/acciones. Muestra props snapshot por ID; hover/menu transitorios se limpian al salir. Presencia no valida ni elimina la entidad | Props/contrato vigentes |
| GalleryChrome/TagNavigation | Misma posición/controles; filtros globales y scope explícito de facetas. Reload no limpia sesión audio | Ningún rediseño |
| useBeatSelection/bulk hooks | selected IDs/version/anchor persistentes en store; revalidación autoritativa antes de comando; nunca poda por evicción | Efecto actual solo en legacy |
| useTagRename | Resolver alcance en SQL/operación durable; no contar windowItems como toda biblioteca ni llamar helper Tauri Web como éxito | Conservar ruta fuera del catálogo |
| usePlaybackQueue/usePlaybackController/useAudio | PlaybackSession estable; engine vive sobre el grid; no releaseFile por evicción. Cola explícita conserva IDs y obtiene detalles bajo demanda | Semántica musical actual |
| useBeatRuntimeRegistry | Vida por operación/audio/editor; liberar estado terminado sin referencias, no por presencia exclusiva en windowItems | Mantener reconciliación actual |
| webAdapter registry/routing/startup | Registrar/borrar referencias de ventana y refcounts; startup≤14; no manifest completo, no cache de todo lo visitado | Mecanismos anteriores |
| webVisiblePlaybackPrefetch/BeatCard observer | Registro/unregistro por nodo y raíz scroller, prioridades compartidas. Dedupe por tenant/era/beat/fileVersion, no por montaje | Adaptador legacy aislado |
| useTagPeek/menus/tooltips | Cerrar al evict, cleanup timers/listeners/portal; no conservar DOM invisible de tarjetas antiguas | Mismo gesto visual |

### Audio, Playbar y cola

Extraer primero las dependencias V02/V03 antes de activar evicción. `currentBeat` se resuelve desde PlaybackSession con snapshot mínimo del beat actual y versión de archivo; no desde windowItems.find. `useAudio` continúa montado en composición estable. Al salir la tarjeta, no llamar releaseFile, limpiar player ni revocar blob URL en uso. La propiedad de URL/stream es del manager de media con refcounts por consumidor: grid,player,editor. Cada cleanup libera su propia referencia; solo refcount0 permite liberar recurso no activo.

Estado de reproducción independiente de query/scroll. Cambiar filtros/columnas no interrumpe audio; cambio de cuenta/logout sí ejecuta teardown explícito de la sesión anterior y descarta respuestas. Cambio de metadata no reemplaza bytes activos inadvertidamente; reemplazo/trash/denegación se procesan como eventos autoritativos según T14, no como ausencia del array. No copiar Player de main ni remontarlo al cambiar anchor.

Cola **explícita**: conservar entradas por identidad/version, resolver la siguiente aunque no esté cargada en Gallery; no hacer filter(liveIds) al evict. UI de cola también debe materializar de forma acotada si es larga; no fijar todas sus BeatCards. Mantener prioridad de cola explícita y reglas repeat/endedSeq del código con tests de caracterización.

**STOP-INTERACTION-QUEUE:** el ámbito de next/prev automático y shuffle hoy es la página materializada/filtrada (V03). Al desaparecer páginas no hay equivalencia única. Recomendación de diseño: fijar query musical al iniciar play, next/prev global por keyset; shuffle requiere sampler SQL acotado con distribución definida, sin `ORDER BY random()` global ni descargar IDs. No queda autorizado por decir «scroll infinito». Antes de V07/T14, alta capacidad registra alcance, efecto de filtros posteriores, repeat-all y algoritmo probado, o una alternativa explícita. No se permite fallback a los DTO que casualmente estén en RAM ni eliminar shuffle para avanzar.

### Selección, edición, DnD y facetas

Selección individual se guarda por `(tenant,beatId,expectedVersion)` y persiste al evict/remontar. Pérdida de visibilidad no es pérdida de selección. Shift usa anchor ID+ordinal+revision, nunca índice local que cambia al prepend. Borrador de edición/detail vive en store externo acotado (un editor activo), conserva campos dirty y versión de origen; un409 no descarta texto. ReturnAnchor no retiene biblioteca entera. Modal/bulk obtiene metadatos por IDs en lotes≤50 y muestra carga/error de los ausentes; no manda solo los IDs cargados como si fueran toda la selección.

**STOP-INTERACTION-SELECTION:** Select All significaba displayedBeats de la página. En una vista infinita hace falta una decisión explícita de alcance. Recomendación: resultados del query con representación server-side de selección/revisión y excepciones, evitando un Set de1M IDs en browser; implica contrato adicional y autorización de producto, no se implementa por esta aprobación. Alternativa: selección del viewport/block con etiqueta inequívoca aprobada. No cambiar Select All silenciosamente a «lo que quedó en caché». Shift que atraviese huecos requiere misma política y resolución acotada. Hasta cerrar esto, se puede probar selección individual en fixture, pero no habilitar POSTGRES real con controles incompletos.

Los lotes de50 siguen atómicos individualmente; una selección mayor no se convierte en transacción ilimitada ni éxito total si hubo errores. V00/V07 debe fijar reporte/progreso/cancelación de bulk antes de ampliar tamaño lógico; no añadir la semántica comercial de seleccionar todo por silencio.

DnD manual: **resuelto por evidencia V13**, mantener false en Web. No es un bloqueo nuevo ni excusa para añadir reordenamiento. LEGACY/Desktop no cambian. Drag OS de archivos e imagen/proyecto sobre tarjeta sí se conserva: capturar target beatId/version al inicio/drop, mostrar estado en store de operación; si target se desmonta antes del drop, cancelar targeting, no subir al nodo reutilizado. Overlay de drag, menú y preview máximo uno por interacción. Si futura instrucción habilita reorder Web, abrir diseño propio (neighbor IDs/expectedRevision y CAS), nunca enviar todos los IDs de biblioteca a SortableContext.

Facetas: no son el predicado de búsqueda, que ya es global ANY/exclusión. allTags/tagFrequency/rename hoy usan array local. Recalcular Tag Bar en cada scroll haría desaparecer tags sin acción del usuario. **STOP-INTERACTION-TAGS** antes de conectar GalleryChrome: alta capacidad fija universo y orden de facetas y alcance rename. Recomendación: facetas SQL acotadas/paginadas estables por revision, preservando exactitud de tags y mostrar activos aunque no estén en bloque; no descargar todos los tags de1M beats. La normalización visual existente y tags legacy con espacios/case requieren fixtures. No autorizar rename global de datos por el simple cambio de scroll.

### Hover, artwork, observadores y recursos

Una tarjeta que sale del overscan se desmonta realmente. Cleanup debe cancelar timeouts que puedan añadir listeners después del unmount (V06), listeners, observer.observe, popovers/portals, drag visuals y suscripciones. Hover empieza false al nuevo montaje. Ningún menú fuera de pantalla queda abierto.

Artworks se sirven por referencia/version; no insertar base64 en todos los DTO de bloque ni conservar promesas exitosas indefinidamente (V07). Capa de thumbnail con LRU por bytes y owners; visibilidad activa solicita, resto espera. Player/editor pueden retener su imagen independiente dentro de presupuesto. Cancelar/ignorar resultado cuando cambió account,queryGeneration o fileVersion; no volver a añadir DTO evictado como efecto de terminar una imagen. Medir objetos, listeners y decoded bytes tras miles de ciclos; un Map de claves pequeñas también puede crecer sin límite.

Warm audio está coordinado por un manager global de la sesión, no por cada remontaje. Los14 candidatos iniciales son límite de startup, no licencia para precargar cada bloque completo. Mantener prioridad de usuario/seek sobre warmup. Disconnect al salir de cuenta; no disconnect global al sacar una fila del DOM.

## 7. Navegación, accesibilidad y errores

**B-experiencia APROBADA:** una Gallery continua sin pager, query global antes de LIMIT, desmontaje/rehidratación, reset al cambiar búsqueda/tags/sort. La selección/draft/audio no desaparecen porque una fila se evicta. La política visible adicional de selección/cola/facetas se cierra en V00, sin reinterpretar la aprobación.

**B-legacy PENDIENTE:** conservar el algoritmo técnico r2 de parser y resolver (offset seguro, primer parámetro legacy, fuera de rango→último bloque en orden global, intento acotado en rango), ahora su salida abre **ancla de la vista continua**, nunca pager.10.000 en rango y mensajes/destino no resoluble siguen solo propuestas. Un bgPage puede mostrar beat diferente por orden global; ese impacto debe aceptarse explícitamente. Si no resoluble, se recomienda estado visible y acción elegible Ir al inicio, sin salto automático ni barrido. No convertir «perfecto/ok» del anexo en aceptación de esos detalles.

Nueva navegación: URL conserva `/gallery`, parámetros de filtros/sort y hash ajeno; ancla opaca opcional `bgAnchor=<resumeCursor>` por cuenta/contexto. No emitir números de página, scrollTop absoluto como autoridad, IDs Telegram ni token por cada pixel. history.replaceState como máximo al estabilizar bloque (debounce300ms propuesto); pushState para cambios deliberados de query/detail, no cada carga automática. Popstate cancela generación y restaura query+ancla si vigente;100 entradas del historial browser no autorizan almacenar100 copias del catálogo. Root/login/signup conservan auth/lazy y redirección al destino con intención; sin contexto autorizado no pedir medios ni resolver tenant del token.

Errores propuestos usando C12-r2:

| Evento | Estado y acción | Prohibición |
| --- | --- | --- |
| Primera carga pendiente | Skeleton de filas medido, aria-busy del área de resultados, Toolbar usable | No Empty Gallery ni esperar Direct |
| Éxito count0 | Empty Gallery o No matches según query/totalLibrary | No usar longitud de caché como prueba |
| Fetch frontera falla/503/offline | Conservar filas/anchor, error en frontera con reintento; dedupe único, sin retry infinito | No ocultar todos los resultados ni concatenar datos viejos |
|400 cursor inválido | Mostrar enlace inválido; acción de reinicio explícita | No consultar INDEX ni tokens de otro tenant |
|409 CURSOR_STALE o feed410 | Cancelar pendientes, retener audio/draft válido y filtros; recargar contexto y primer bloque con aviso; solo una recuperación automática por generación | No mezclar bloques de revisiones ni prometer posición exacta tras mutaciones |
| Account switch/logout | Teardown audio/routing/store/abort de A; B comienza en su query/contexto, sin bgAnchor heredado | No reinterpretar token A como ordinal B |
| Cambio q/tags/sort | Nueva queryGeneration, reset top, descartes tardíos; conserva preferencias/estado externo según contrato aprobado | No filtrar ventana local como resultado global |
| Edición/trash/restore cambia revisión | Mismo protocolo stale; conflictos conservan draft; no patch parcial de ordinales globales | No corregir conteo/posición suponiendo solo ventana |

Reset por revisión es política propuesta ya descrita r2, no forma de esconder inestabilidad: T20 mide frecuencia y efecto con escritores concurrentes. Si interrupciones impiden recorrer la biblioteca, STOP-NAV para revisar estrategia de anclas/deltas. No relajar validación de revisión silenciosamente. Copys finales y destino de enlaces legacy requieren decisión B-legacy; no son aprobados aquí.

Accesibilidad de diseño: usar estructura feed/article para tarjetas con controles internos, filas role=presentation; conservar botones/nombres accesibles existentes. `aria-posinset=ordinal+1`, setsize=totalMatched si exacto, −1 si desconocido según semántica aplicable; live region moderada para carga/error, no anunciar cada scroll. No mezclar listbox con todos los controles interactivos dentro sin patrón validado. El patrón feed exige coordinar foco con carga/retirada; no basta añadir un role. [WAI-ARIA Feed](https://www.w3.org/WAI/ARIA/apg/patterns/feed/).

Teclado: Tab/Shift+Tab entre controles, avance de artículo con PageDown/PageUp sin robar inputs; cargar frontera y luego mover foco. Mantener como máximo una fila adicional de foco; si pointer-scroll la aleja más de2 viewports, trasladar foco al contenedor estable con preventScroll y guardar target para reentrada, nunca dejarlo caer en body. Reentrada por teclado rehidrata antes de enfocar. Cerrar detalle restaura control original si vigente. Menú Escape cierra y devuelve foco; navegación por teclado no depende de hover.

Home/End/Ctrl+End y arrastre de scrollbar necesitan fixture explícita del track móvil. Ctrl+Home puede abrir primer bloque; Ctrl+End requiere consulta última ventana por orden inverso dentro del mismo query (sin OFFSET profundo) y count consistente. No fingir que el extremo físico intermedio es final global. V02 fija soporte `edge=last` en lectura antes del test; si no existe o costo/foco no cumple, STOP-NAV y revisión. Accesibilidad con lector de pantalla y móvil es gate real de V09, no se valida solo con jsdom.

## 8. Tareas granulares y dependencias

Estos IDs **V00–V11 subdividen tareas existentes**, no renumeran T00–T25 ni abren gates. Una IA recibe una subtarea por encargo. Cada entrega registra archivos, comando creado/existente, resultado, artefactos y STOP. No ejecutar estos pasos por haber recibido el anexo.

### V00 — Fijar contrato e interacciones (T00/T01, alta capacidad)

Antes de T01: registrar A1/A2 y B-legacy, y políticas de selección/cola/facetas anteriores. Experiencia infinite aprobada no se vuelve a preguntar. Tras G0/T00 formal y autorización T01, completar mapa consumidores/datos e inventario de snapshots/Maps/setBeats. Salida: mapa cerrado de tipos y cada consumidor clasificado window/entidad/operación/global SQL. STOP si un array parcial sigue tratado como biblioteca completa o interacción visible cambia sin registro. No coding de runtime.

### V01 — Fixtures y arnés seguro (T01→T02)

Crear fixtures de240/241, bloques en ambas direcciones,1/2/3/4/5/6/7 columnas, imágenes retardadas, metadata larga, currentBeat fuera de ventana, selección/borrador offscreen y cuentaA→B. T02 añade transporte falso, reloj controlable, contadores de fetch/unmount/listeners/blobURL y harness de navegador que no monta auth/Telegram reales. PASS: tests del propio arnés, prohibición de DB ajena/red externa demostrada. STOP-ENV si no está aislado. No usar postgres-live ni el probe como sustituto.

### V02 — Contrato de lectura y cursores (T06, después T05 y A1/A2)

Añadir al esquema/API existente de T06 `resumeCursor` inclusivo, ordinal/count consistentes, before/after internos y `edge=last` con lectura inversa. Usar `GET /catalog/v1/beats` también para reopen por resumeCursor; **no crear endpoint alternativo elegido por ejecutor**. Rechazar cursor+edge ambiguos. Resolver legacy propuesto separado según política B-legacy aprobada, salida ancla/bloque. Probar vuelta a bloque evictado, fronteras parciales, tenant/revision,100k/1M SQL sin recorrer cursores ni OFFSET no autorizado. PASS con EXPLAIN/casos correctos; STOP-DESIGN/PERF si count/seek no cumple.

### V03 — Geometría pura y CSS fixture (T08, V01/V02)

Archivos `catalogRowGeometry.ts`, tests geométricos y fixture DOM real del layout LOCAL. Medir C/H/G/padding y límites por ancho con CSS actual; implementar filas/espaciadores/originRow/anchor y fórmula de overscan. No conexión productiva ni modificación DESIGN. PASS: mismos track width/altura/gaps, anchor≤1 CSSpx de deriva tras prepend/evict/resize sin acción del usuario; total de objetos geométricos no crece con N. STOP-LAYOUT ante discrepancia no explicada.

### V04 — Store acotado (T08, V02/V03)

Crear catalogQueryStore con6 bloques, budgets5, singleflight/abort/generaciones; vecinos before/after, evicción extremos y DTO de borde. No Playbar ni selección dentro del store de ventana. PASS: máxima residencia/bytes/inflight instrumentados, dedupe exacto y retorno por cursor de frontera sin índice global de1M IDs. STOP-BUDGET/INTEGRITY si caché necesita crecer para avanzar o hay ordinal repetido incompatible.

### V05 — Grid y navegación aislados (T08, V04)

CatalogVirtualGallery+hook en fixture; un scroller, placeholders de frontera, vuelta atrás, resize, foco y detalle; sin pager POSTGRES. Eventos catálogo separados de legacy. Búsqueda/ANY/exclusión/sort vienen SQL mock y tienen match después240. PASS: desmontaje real y no resort local, scroll infinito en fixture y ninguna llamada INDEX. No habilitar rama producto hasta V06–V09; pruebas de T08 con feature off no equivalen a lanzamiento.

### V06 — Separar playback/recursos (T14, depende T13 y V04)

Crear PlaybackSession/adaptar controller,queue,registry y currentBeat. Implementar política musical aprobada V00, preservar prioridad de cola/repeat/seek. Auditar todos releaseFile/URL revocation; reemplazar pruning por array con eventos autoritativos. Limitar caches/artwork/promesas/routing y registrar/unregistrar nodos. PASS: reproducir+seek mientras tarjeta/DTO se expulsan, scroll inverso y account switch correcto. STOP-PLAYBACK ante interrupción por eviction, pérdida de queue IDs o fuente de otra cuenta.

### V07 — Selección/edición/drop/facetas (T13/T14, V00/V04)

Crear InteractionStore y adaptar bulk/drawer/tagRename/GalleryChrome conforme política explícita. Individual/shift/Select All no dependen de qué bloques LRU siguen vivos. Mutaciones C5 con version y lotes50; detalle retorna a anchor; drop sobre ID/version estable; manual reorder Web=false. PASS: operación sobre seleccionado evictado no se pierde, conflicto preserva draft, facetas estables, ninguna acción global procesa solo windowItems. STOP-INTERACTION si política no cerrada o test requiere eliminar una capacidad.

### V08 — Integrar composición por autoridad (T16, V05/V06/V07 y T15)

Separar providers LEGACY/POSTGRES, cablear AppShell/WebGalleryWorkspace; catálogo conserva auth/lazy y rutas. Excluir de POSTGRES selector local, cache global de beats, INDEX reload/reconcile y pager. Mantener flags apagados por defecto y fail-closed. PASS: spies de todas rutas+auth, Direct desconectado no bloquea metadata, LEGACY sin regresión. No tocar main/DESIGN ni reemplazar Playbar. STOP si autoridad/contextounknown activa camino legacy por error.

### V09 — Regresión navegador/accesibilidad (T16/T21, V08)

Chrome/Edge y viewports soportados con fixtures aisladas; pruebas teclado/lector/foco, resize, detalle, selección, barra scroll, mobile/touch y reduced-motion. Capturas comparan geometría y UI contra LOCAL, no contra main. Ejecutar pruebas originales pertinentes auditadas, sin suites reales. PASS: casos9 completos,0 skips obligatorios, capturas y contadores adjuntos; STOP-UX si interacción/lectura accesible se pierde.

### V10 — Capacidad y leak soak (T20, V09 y T19)

Aplicar perfil C11-LAB-v1 de r2 más navegador/métricas9.100k/1M, recorrido completo y vuelta atrás sin guardar IDs completos en cliente, autores concurrentes, red lenta,imágenes,memoria/buffers/requests. Medir perf antes/después de optimizar. PASS solo métricas reales y budgets; STOP-PERF ante leak/slope/pausas/carga ilimitada. No bajar dataset, aumentar budgets o simular benchmark con tiempo de un script puro.

### V11 — Candidato y migración (T21→T23, V10 y G0–G4)

Consolidar evidencia, flags, compatibilidad legacy y rollback con escrituras; CLI T17/T18 debe comprobar perfil/rutas/guardas vigentes, sin modificar esta numeración. Un piloto necesita autorización independiente de biblioteca/entorno y B-legacy resuelto. PASS de documentos no autoriza deploy, DB, Telegram ni AWS. STOP si A1/A2/UX/legacy siguen pendientes o faltan restores/fencing.

## 9. Pruebas y aceptación medible

Todos estos casos son **futuros**. No se ejecutaron tests de producto, SQL, virtualización ni benchmarks en este encargo documental. El experimento Node/Chrome Unicode de r2 se conserva como histórico, no como prueba de scroll.

| Caso estable | Fixture / operación | Evidencia obligatoria y STOP |
| --- | --- | --- |
| C12-V-GEOM | N0/1/239/240/241/100k/1M; C1…7; resize cruzando359/590/750/940/1160/1400 ±1px | H/C/gap/padding medidos, IDs/ordinales y screenshots; anchor deriva≤1px, sin repetición/huecos |
| C12-V-SCROLL | Ir abajo y atrás más allá de6 bloques; bloquear respuesta; invertir dirección; fast fling | Mount/unmount real, budgets5,previousCursor de frontera, sin replay desde inicio; placeholders con retry en error |
| C12-V-BORDER | Bloques240 con7 columnas; evict/prepend sobre fila compartida; último bloque parcial | Carry≤2(C−1), ninguna tarjeta duplicada; columnas no cambian por tamaño de última fila |
| C12-V-FOCUS | Tab/shift,PageUp/Down,Home/End,menu Escape,detalle retorno,lector de pantalla | Foco nunca desaparece a body; rehidratación antes de focus; scroll real y lectura continua |
| C12-V-MEDIA | Play tarjeta, scroll hasta evict, seek,next/prev/queue,replace/trash, audio lento | Player/engine sigue montado; no release por eviction,0 URL activas revocadas indebidamente; política musical V00 |
| C12-V-RESOURCES |10.000 ciclos mount/unmount con menus/artwork/hover y StrictMode | Conteo de timers/listeners/observers/blob URLs vuelve al baseline acotado, promesas y Map no crecen por visitas |
| C12-V-INTERACTION | Seleccionar,evict,editar/bulk conflict,drop retarget,tag rename/facetas | IDs/version correctos fuera de ventana; política V00, no conjunto parcial presentado como completo |
| C12-V-QUERY | q/tags/sort durante fetch, coincidencias solo después240,ANY+exclusión,revision writer | SQL global; queryGeneration descarta vieja respuesta, reload único y draft/audio no perdidos |
| C12-V-AUTH | A→logout→B con media/metadata en vuelo; cursorA aB; contexto503 | Cero dato/ref/URL/selección deA enB; ningún fallback INDEX ni petición de medios antes de auth |
| C12-V-LEGACY | LEGACY `/gallery?bgPage=240`, POSTGRES mismo link, deep no resoluble,root/login/signup/hash | Pager solo LEGACY; POSTGRESancla y política aprobada B-legacy; sin visitas de miles de cursores |
| C12-V-PERF | C11 total100k/1M + biblioteca1×100k, fixture UI1×1M (solo stress, no cuota prometida) | EXPLAIN/API/RSS/heap/DOM/frames/bytes/calls, perfiles y cifras reales, no screenshot como benchmark |

C11-LAB-v1 del acta sigue vigente para servidor. Añadir manifiesto cliente: browser exacto/flags/UA, SO,CPU/RAM/GPU,display refresh,DPR,viewport,zoom,fuentes,headful/headless y red. Comparar mismas condiciones a100k/1M; incluir anchos375,768,1440 y los breakpoints±1; zoom100%/200%,touch donde soporte,reduce-motion. No probar fuentes/altura solo en jsdom.

Presupuestos UI candidatos para V10 (objetivos, no mediciones ni promesa): mismo techo de bloques/DOM para100k/1M; incremento heap/RSS de estado estable atribuible a N≤20 MiB tras recorrido comparable, además del límite C11 de primera carga. Soak≥20min con backtracking; tendencia de crecimiento tras GC controlado en laboratorio debe estabilizarse. Guardar valores pico antes de GC también. Frames de interacción local sin espera de red en monitor60Hz: p95≤16,7ms y p99≤50ms, sin tareas>200ms repetidas por scroll/evict; incumplimiento→STOP-PERF con trace, no ocultar montajes ni desactivar artwork para reportar PASS. Budget32 MiB artwork es objetivo de cache propia, no una afirmación sobre la memoria interna del navegador.

Escenarios red aislada: metadata50/250/1000ms, artwork retardado2s/error, respuestas invertidas y fallos500. El caso lento permite skeleton de frontera; no exige datos antes de recibirlos ni relaja límites. Ningún intento normal necesita SQL abierto entre scrolls ni Telegram para metadata. Cargar100k/1M en el **servidor fake** del test es distinto a pasarlos como prop array del cliente: prohibido ese atajo en prueba de memoria.

Recorrido completo en orden y reversa: verificar count+digest incremental de secuencia frente al esperado, sin Set/array de1M IDs en browser de prueba. Track máximo y número de DOM nodes instrumentados durante todo el recorrido. Incluir salto al último bloque por consulta inversa y volver desde detalle con cache fría. Remontar100.000 tarjetas a la vez, descargar todas para sort o mantener historial infinito de cursores produce FAIL aunque la UI parezca fluida.

Comandos futuros: T02 crea/valida manifiesto del runner; los casos se adscriben a `catalog-check.cjs T06`, `T08`, `T14`, `T16` y `perf` según tarea. Una subtarea que aún no puede correr su grupo completo registra sus casos aislados reales y pendientes; solo la tarea T correspondiente recibe PASS cuando todo su manifiesto pasa. No ejecutar estos nombres antes de que existan ni reportar un SKIP como PASS. V09 se ejecuta para T16; T21 consume/revisa su evidencia después de T20, sin dependencia circular T20→T21→T20.

## 10. Estado histórico r3 y transferencia — sustituido por r4

- **B-experiencia: APROBADA** según anexo oficial; no volver a solicitar esa aprobación.
- **B-legacy: PENDIENTE** (cota10.000,copy,destino no resoluble). Recomendación técnica no es aceptación.
- **A1/A2: PENDIENTES** según r2; se conservan fixtures, algoritmos y diferencias.
- **Interacciones derivadas:** STOP-INTERACTION-SELECTION/QUEUE/TAGS antes de conectar capacidades que antes dependían de página; opciones y razón concretas en6. No bloquean esta entrega documental, sí su futura activación. DnD manual Web está resuelto: conservar false.
- T00 global NO PASS, G0 NO APROBADO, T01 BLOQUEADA, T02 NO INICIADA. No hay gate ni permiso de implementación nuevo.

La siguiente inteligencia ejecutora **no debe empezar V01/T01**: recibe los documentos, verifica estado y entrega los puntos pendientes a alta capacidad. Una vez cerrados y autorizado el trabajo, seguir V00–V11 en las tareas padre, una subtarea por encargo. Ante STOP registrar: query/contexto sintético, expected/actual, contador/trace, fuente/versión, diff de archivos y decisión requerida. No elegir otra biblioteca de virtualización, otro alcance de selección o un límite mayor para continuar.

Pruebas reales de este encargo: inspección Git/código; verificación15 hashes locales; snapshot remoto; comprobaciones documentales de enlaces/fences/diff/alcance al cierre. Sin nuevas suites de producto ni medición visual/performance real. Se registrarán resultados exactos de esas comprobaciones en EVIDENCIA/ESTADO.


## 11. Verificación documental ejecutada y paths

Resultado de esta integración: `git diff --check` PASS; enlaces locales y fences de todos los MD del paquete PASS. Caracterización r2 idéntica byte a byte a la copia previa. Los cinco MD remotos incorporados son idénticos byte a byte al snapshot `b585540`. No se reejecutó baseline68/68, probe PostgreSQL, fixtures de navegador ni performance. Las inspecciones y verificaciones de archivos no son PASS de V00–V11/T01/G0.

Paths **modificados en este encargo**, todos bajo `docs/plans/catalogo-postgresql/`: `C12-DECISION-RECORD.md`, `CONTRATO.md`, `ESTADO.md`, `EVIDENCIA.md`, `README.md`, `TAREAS.md` y `T00-REVISION-20261107.md` (solo adición histórica remota).

Paths **incorporados nuevos**: `C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md`, `C12-B-HANDOFF-IDE-GALLERY-INFINITA-20261107.md`, `G0-C12-IDE-MASTER-PROMPT-20261107.md`, `G0-LAB-POSTGRES-ACTIONS.md`, `G0-POSTGRES-VERIFIED-20261107.md` (remotos) y `C12-B-INTEGRACION-Y-PLAN-20261107.md` (este plan). `C12-CARACTERIZACION-20261107.md` ya era local sin seguimiento y **no fue modificado**; el estado Git la sigue mostrando como no rastreada. No se tocó `Claude outputs/` ni `beatgaler-console.jpg`.

El diff contra HEAD incluye trabajo r2 preexistente además de esta integración; para distinguirlos usar copia versionada y este inventario, no atribuir todo `git diff` al último encargo. No hay cambios fuera de documentación en working tree; fetch solo actualizó objetos/refs Git autorizados. HEAD permanece a446219; no se afirma que la rama local haya avanzado a b585540.

## Transferencia normativa vigente C12-r4

[cierre C12-r4](C12-V00-CIERRE-20261107.md) integra las aprobaciones explícitas y sustituye pendientes/recomendaciones incompatibles r2/r3. A1 ICU fijo, A2 binary64/clase y B-legacy <=10.000 quedan aprobados. I1 selección global con aviso solo si había selección; I2 audio continuo, nuevo query y cola prioritaria, Shuffle sin repetición por ronda; I3 rename ACTIVE/TRASH sin modificar estado. Se descarta fijar permanentemente la búsqueda musical al pulsar Play.

Aplicar las dependencias, algoritmos, alternativas y STOP de sección 7 del cierre a T01/T03/T06/T07/T13/T14/T20 y V00–V11. Membresías SQL persistidas, selección CAS, facetas, journal y swaps Shuffle no son memoria global del cliente. T01/T06 deben producir inventario y contratos tipados completos en sus tareas futuras. T00 revisa formalmente base/descriptor/baseline/contrato, sin volver a solicitar las aprobaciones resueltas. T01 permanece bloqueada; ningún paso de implementación iniciado.
