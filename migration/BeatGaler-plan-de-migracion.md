
Fecha del análisis: 5 de septiembre de 2026. Rama: `integration-v0.8.0-alpha.1`.

Base examinada: [`f5dd24de6049453c735c4daf34066065c5773280`](https://github.com/magosouljah/BeatGaler/tree/f5dd24de6049453c735c4daf34066065c5773280).

**Objetivo:** dejar `App.tsx` como punto de composición mínimo y repartir las responsabilidades actuales de BeatGaler sin cambiar su comportamiento observable, sus transacciones ni sus reglas de plataforma.

Este documento es un plan para implementación. Se descargó y examinó el código; no se modificó el código del repositorio ni se ejecutaron builds, pruebas o una sesión funcional. Los hallazgos son de lectura estática. La primera etapa establece la línea base ejecutable.

**Si una comprobación de GitHub Actions falla, no dependas del log completo mostrado por GitHub Actions. Busca el artifact `migration-check-logs-*` generado por el workflow de comprobación, descárgalo usando las herramientas de GitHub y lee primero `summary.txt` y después el `.log` correspondiente al check fallido. Usa ese archivo para identificar el error exacto y continuar. Solo considera un bloqueo si el artifact no existe o técnicamente no puede descargarse; en ese caso registra exactamente qué acceso falló. Si una prueba nueva o modificada falla, el fallo no demuestra por sí solo que la prueba o el código estén mal: investiga la causa y determina con evidencia si falla la implementación, la prueba, un contrato previo o el entorno antes de corregir.**

## 1. Diagnóstico

`src/App.tsx` tiene **5,687 líneas físicas**, contando blancos y comentarios. Hay una distinción útil: la función exportada `App()` ya tiene solo cinco líneas, al final del archivo. El problema es que el mismo archivo contiene `BeatGalerApp`, cinco componentes auxiliares, persistencia, reglas de dominio y casi toda la coordinación de la aplicación.

La reducción del archivo no basta: mover su contenido entero a `BeatGalerApp.tsx` o a `useBeatGalerApp.ts` sería únicamente un paso intermedio.

Ya existen bases que conviene conservar:

- `src/platform/`: contratos, capacidades y adaptadores de escritorio y web.
- `src/lib/libraryStateManager.ts`: serialización de lecturas y commits del índice desde este renderer.
- `src/features/state/beatRuntimeState.ts`: estados de sincronización, reproducción y descarga por beat.
- `src/features/playback/`: rutas, preparación web, prioridades, invalidaciones y diagnóstico.
- `src/features/import/`, `dragdrop/`, `artwork/`, `library/`, `cloud/`, `downloads/`, `edit/`, `trash/` y `auth/`.
- `src/hooks/useAudio.ts`: una instancia de audio y el manejo de sus eventos.

La nueva estructura debe completar esas fronteras, evitando crear un segundo sistema paralelo con los mismos cometidos.

## 2. Mapa del código actual y destinos

Las líneas siguientes corresponden exclusivamente al commit analizado. Algunos dominios aparecen en varios tramos porque hoy están entrelazados.

### Componentes y presentación

- `CloudFilesModal`, líneas 123–260 → `features/downloads/components/CloudFilesModal.tsx`.
- `BeatFileDropModal`, 262–344 → `features/dragdrop/components/BeatFileDropModal.tsx`.
- `SearchBar`, 348–375, y `SortMenu`, 377–484 → `features/library/components/`.
- `TagColorMenu`, 486–534 → `features/tags/components/`.
- JSX principal, desde 5024 → header, selección, filtros, galería, avisos, ventanas y player conectados a sus respectivos módulos.
- `App()`, 5683–5687 → conservar su selección actual: web monta `BeatGalerApp`; escritorio monta `AccountGate` alrededor de `BeatGalerApp`.

[Fuente: componentes auxiliares y entrada actual](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/App.tsx#L123).

### Biblioteca, sesión y arranque

- Caché, marcadores de uploads, fingerprints y preservación de artwork, 541–770 → dividir entre caché de biblioteca, recuperación de uploads y artwork.
- Estado `beats` y sus referencias, desde 773 → `features/library/useLibraryState.ts`.
- Registro de estados por beat, 798–867 → `features/state/useBeatRuntimeRegistry.ts`.
- Arranque, 1004–1189 → `features/startup/useStartupBootstrap.ts`.
- Reconexión, 1191–1282, y SSE, 1322–1463 → `features/session/useConnectivity.ts` y `features/cloud/useCloudLibraryEvents.ts`.
- Escritura de caché y orden, 1468–1495 → biblioteca.
- Recarga manual/diferida, 4402–4511 → `features/library/useLibraryReload.ts`.
- Revelado de tarjetas, 4806–4906 → `features/startup/useLibraryReveal.ts`.

[Fuente: arranque y reconciliación](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/App.tsx#L1004).

### Reproducción y artwork

- Eventos de audio e invalidación, 1524–1598 → playback.
- `ensureWarmPlaybackUrl`, 1642–1683, y preparación posterior a upload, 1746–1803 → `features/playback/usePlaybackPreparation.ts`.
- `ensureArtworkReady`, 1685–1744, y `decodeArtworkDataUrl` → `features/artwork/useArtworkHydration.ts` y helper de decodificación.
- `handlePlay`, 1810–1950 → `features/playback/usePlaybackController.ts`, conservando sus rutas web/escritorio.
- Cola, siguiente/anterior, shuffle, repeat y `endedSeq`, 4926–5018 → `features/playback/usePlaybackQueue.ts`.

[Fuente: preparación y play](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/App.tsx#L1642).

### Cloud, importación y edición

- `cloudifyImportedBeats`, 2189–2606, y retry, 2608–2620 → cola de uploads, pipeline de escritorio y adaptación web dentro de `features/cloud/`.
- Review, Save/Skip/Cancel/Save All, 2622–2840 → `features/import/useImportReview.ts` y `useImportSaveAll.ts`.
- Descubrimiento incremental, 2842–3016 → `features/import/useImportDiscovery.ts`.
- Decisiones diferidas, 3018–3035, y callbacks de conflictos en JSX → módulo de importación.
- Importación de `File` web, 3686–3723 → `features/import/useBrowserImport.ts`, reutilizando `platform.importer`.
- Observer de metadata, 3140–3222; commit de Drawer, 3253–3312; artwork, 3420–3485 → módulos de edición con coordinación explícita de fingerprints/commits.

[Fuente: pipeline de uploads](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/App.tsx#L2189).

### Proyectos, drop, downloads, offline y selección

- Upload/open/update de proyecto, 1989–2052; indicadores, 3037–3060; operaciones de proyecto, 3530–3632 → `features/projects/`.
- `runBeatCloudUpdate`, 3488–3528, y reemplazo de slots → servicio de actualización de assets dentro de `features/edit/`; dragdrop solo enruta la intención.
- Integración HTML, 3774–3877, y listener nativo, 3879–4256 → `features/dragdrop/`.
- Exportación/descargas, 4258–4400 → `features/downloads/useBeatDownloads.ts` y listener de eventos.
- Available Offline, 3314–3418 → `features/offline/useOfflineAvailability.ts`.
- Borrado individual, 4543–4618; masivo, 2065–2149; restore dentro de Settings → `features/trash/`.
- Selección, 4620–4640, y reconciliación con la biblioteca, 4912–4924 → `features/selection/` y un enlace explícito con playback.
- Tags, 4644–4692 y 4735–4777 → `features/tags/`.
- Reordenamiento interno, 4694–4731 → `features/library/useLibraryReorder.ts`.
- Filtros y orden, 4779–4804 → selectores de biblioteca.

[Fuente: drop nativo y downloads](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/App.tsx#L3879).

## 3. Estructura propuesta

Los nombres son una propuesta. Las carpetas existentes se amplían; no se sustituyen en bloque.

```text
src/
  App.tsx
  app/
    BeatGalerApp.tsx
    useBeatGalerComposition.ts
    AppShell.tsx
    useAppShortcuts.ts
    components/AppNotices.tsx
  features/
    session/
      useSessionState.ts
      useConnectivity.ts
      useSessionActions.ts
      useCustomCursor.ts
    startup/
      useStartupBootstrap.ts
      useLibraryReveal.ts
      startupLoader.ts
    library/
      useLibraryState.ts
      useLibraryReload.ts
      useLibraryReorder.ts
      libraryPresentationCache.ts
      librarySelectors.ts
      libraryFingerprints.ts
      components/LibraryHeader.tsx
      components/LibraryGrid.tsx
      components/SearchBar.tsx
      components/SortMenu.tsx
      ...módulos web existentes
    state/
      useBeatRuntimeRegistry.ts
      beatRuntimeState.ts
    playback/
      usePlaybackController.ts
      usePlaybackPreparation.ts
      usePlaybackQueue.ts
      components/PlaybackPanel.tsx
      ...módulos actuales
    artwork/
      useArtworkHydration.ts
      decodeArtworkDataUrl.ts
      ...caché y descarga existentes
    cloud/
      useCloudLibraryEvents.ts
      useCloudUploadQueue.ts
      desktopBeatUploadPipeline.ts
      interruptedUploadJournal.ts
      uploadErrorDetails.ts
      ...transporte web existente
    import/
      useImportSession.ts
      useImportDiscovery.ts
      useImportReview.ts
      useImportSaveAll.ts
      useBrowserImport.ts
      components/ImportReviewHost.tsx
      ...módulos existentes
    edit/
      useBeatEditing.ts
      useMetadataSync.ts
      useDrawerCloudCommit.ts
      useBeatAssetUpdates.ts
      components/BeatEditorHost.tsx
      ...webBeatEdit.ts
    dragdrop/
      useHtmlLibraryDrop.ts
      useNativeLibraryDrop.ts
      nativeDropTargets.ts
      components/BeatFileDropModal.tsx
      ...controller, arbiter y staging existentes
    projects/
      useBeatProjects.ts
      projectDropPolicy.ts
    downloads/
      useBeatDownloads.ts
      useDownloadEvents.ts
      components/CloudFilesModal.tsx
      ...webDownloads.ts
    offline/
      useOfflineAvailability.ts
    trash/
      useTrashActions.ts
      ...webTrash.ts
    tags/
      useTagFilters.ts
      useTagRename.ts
      tagSelectors.ts
      components/TagFilterBar.tsx
      components/TagColorMenu.tsx
      components/TagRenameDialog.tsx
    selection/
      useBeatSelection.ts
      components/SelectionToolbar.tsx
    publishing/
      usePublishingDialog.ts
  hooks/useAudio.ts             # conservar inicialmente
  platform/                    # conservar contratos/adaptadores
  lib/libraryStateManager.ts   # conservar la instancia y su contrato
  lib/tauri.ts                 # conservar durante la extracción principal
  components/                  # componentes existentes, sin traslado masivo
```

`publishing` identifica el diálogo de YouTube; no se mezcla con los uploads de la biblioteca a Telegram.

### Tamaños orientativos

- `App.tsx`: 8–15 líneas con imports.
- `BeatGalerApp.tsx`: 40–100, composición de las regiones principales.
- `useBeatGalerComposition.ts`: aproximadamente 100–200, exclusivamente conexiones entre APIs de módulos.
- Archivos de lógica: preferentemente 100–300; revisar la frontera de responsabilidad si superan 350–400.
- Volumen aproximado de lógica trasladada por dominio: startup 300–500; session 200–350; library 300–500; playback 450–650; artwork 100–200; cloud 800–1,100; import 600–900; edit 250–450; dragdrop 500–700; projects 200–350; downloads 180–300; offline 120–200; trash 180–300; tags 120–200; selection 70–140; runtime 80–150.

Estos rangos son estimaciones de descomposición, excluyen UI y módulos que ya existen y no son un presupuesto aditivo exacto. Imports, interfaces y pruebas harán crecer el total. No se comprime el código ni se crean fragmentos arbitrarios para cumplir un número.

## 4. Quién posee el estado y cómo se comunican los módulos

**Biblioteca:** un único dueño de `beats` y del acceso a su snapshot actual. El caché visual, los candidatos de Review y la autoridad remota mantienen significados distintos. `libraryStateManager` sigue siendo el coordinador existente de operaciones autoritativas; no se crea otra cola equivalente.

**Sesión:** dueño de `settings`, `setupDone`, `connectionState` y `cloudSessionVerified`. Conectividad y verificación de autoridad no se sustituyen por un único booleano. Arranque, reconexión, SSE y logout solicitan transiciones mediante una API acotada.

**Runtime:** dueño de `beatRuntimeStates`, su referencia actual y las transiciones. Preserva estados de borrado e intenciones offline aunque el beat ya no esté visible. No se convierten sus estados transitorios en persistencia.

**Importación:** dueño del cursor de Review, candidatos, decisiones pendientes, ejecuciones de descubrimiento y referencias a staging. El upload recibe acceso de lectura a las fuentes todavía protegidas. Un candidato entra en biblioteca solamente después de Save.

**Uploads:** dueño de la cola, IDs activos, marcadores de recuperación, errores y timers de finalización. Expone `enqueue`, `retry` e información de actividad para que Reload pueda diferirse. El pipeline de escritorio conserva sus checkpoints.

**Playback:** dueño de preparación, URLs temporales, promesas en vuelo, época de caché y cola del usuario. Conserva una sola instancia de `useAudio`; la visibilidad del player no determina la vida del audio.

**Artwork:** dueño de las promesas de hidratación/decodificación. Publica cambios de presentación sin convertirlos en commits de metadata.

**Downloads:** dueño de tareas de exportación y sus IDs; cerrar el modal no desmonta el listener ni cancela el trabajo actual. Respeta quién inició el estado de descarga para no finalizar una operación ajena de playback/offline.

**Offline, trash, edición y proyectos:** dueños de sus operaciones y estados ocupados. Coordinan cambios a biblioteca y playback mediante comandos explícitos. Trash conserva el tratamiento diferente entre acción local, intención offline y commit online.

**Selección/tags/UI:** dueños de IDs seleccionados, ancla, filtros y ventanas. Los componentes visuales reciben datos y acciones del dominio correspondiente.

### Contratos y dirección de dependencias

- `app/` importa y conecta features; una feature no importa `app/` ni `App.tsx`.
- UI llama acciones; las acciones de dominio utilizan los adaptadores y contratos ya existentes.
- Las APIs nuevas exponen operaciones concretas como leer la biblioteca actual, publicar una edición, encolar uploads, invalidar preparación o limpiar selección. No exponen un objeto con todos los setters de la aplicación.
- Los tipos pertenecen al dominio que los define. Mantener `Beat` y `AppSettings` en su ubicación actual al principio.
- Mantener nombres y payloads de eventos públicos existentes, así como claves de localStorage. Una migración de eventos o de datos se evalúa por separado.
- Mantener la instancia singleton de `libraryStateManager`: su serialización es por renderer y no garantiza por sí sola resolver snapshots obsoletos ni concurrencia entre dispositivos.

Para evitar ciclos entre hooks: crear primero el estado de sesión, biblioteca, runtime e importación; después las APIs de preparación de audio y uploads; Review recibe `enqueue`, y uploads recibe una función que consulta las fuentes protegidas de importación. Reload recibe una consulta de uploads activos. Startup y SSE reciben las APIs de publicación y verificación. Los enlaces entre cola, selección y biblioteca se componen arriba.

Esta es la dependencia objetivo. Durante la extracción se conserva la posición relativa de los efectos actuales; no se reordenan efectos solo para hacer coincidir el diagrama. Si hace falta, se extrae el cuerpo de un efecto conservando su invocación en el punto original y se consolida después con pruebas.

## 5. Reglas que la migración debe conservar

1. **La caché presenta; la autoridad decide.** Con autoridad desconocida no se publica un índice construido a partir del caché ni se interpreta el resultado como una galería vacía confirmada.
2. **Una biblioteca vacía es válida.** No recuperar automáticamente porque `beats.length === 0`; podría resucitar beats eliminados.
3. **Primero validar offline, luego revelar.** El arranque frío offline muestra paquetes durables. Perder la red durante una sesión conserva la presentación actual y su audio ya preparado según las condiciones existentes.
4. **Revelado independiente de audio.** Las tarjetas reservan su lugar aunque estén invisibles; título y artwork gobiernan la aparición. No volver a bloquear toda la galería esperando el audio.
5. **Review no es biblioteca.** Save confirma el candidato; Skip afecta al actual; Cancel conserva los ya guardados. La primera revisión aparece antes de finalizar el descubrimiento del lote.
6. **Durabilidad por beat en escritorio.** Conservar la secuencia MASTER → WAV/proyecto cuando correspondan → detach local → metadata/artwork → commit del índice por beat → limpiar marcador → preparar playback. No trasladar el commit al final del lote.
7. **Una subida durable no se elimina por un fallo posterior de playback.** La recuperación consulta la autoridad; si no puede verificarla, conserva el marcador y difiere la limpieza.
8. **Staging compartido sigue protegido.** No borrar una sesión usada por otros candidatos o uploads; conservar las diferencias entre rutas originales nativas y copias privadas.
9. **Reload manual se difiere durante uploads.** No introducir un merge optimista nuevo ni extender esa regla a otros disparadores sin comprobar primero su comportamiento actual.
10. **Edición y observer comparten deduplicación.** Sembrar fingerprints en los puntos actuales para que un guardado del Drawer no genere otro commit por el observer de escritorio. Mantener su debounce de 700 ms y su exclusión en web.
11. **Audio y sincronización tienen estados diferentes.** `playing` de runtime depende del evento real del audio. Mantener bloqueos de readiness, cancelación/invalidación de rutas, `endedSeq` y propiedad de estados de download.
12. **No unificar exportación, caché de playback y Available Offline.** Son tres propósitos y ciclos de vida distintos.
13. **Routing de drop por plataforma.** Windows conserva el dueño nativo; macOS combina rutas nativas con artwork HTML conforme al arbitraje existente; web conserva importación de un beat por gesto. Las URLs de Pinterest no entran a importación de audio.
14. **Contratos de DOM y montaje.** Preservar keys, portales, atributos `data-*`, orden de elementos y montaje de listeners. No añadir wrappers que alteren hit testing, dragdrop o `LibraryUxBridge`.
15. **Una sola ruta de autenticación por plataforma.** Conservar `AuthExperienceGate` y la ubicación de `AccountGate`; no duplicarlos al crear la nueva raíz.
16. **Mismos tiempos observables.** Mantener backoffs, pausas entre beats, animación mínima de Reload, duración/volumen de sonidos y timers de avisos. Optimizar tiempos después.

La implementación actual contiene comentarios históricos que no coinciden con la frontera real de upload. La referencia es la llamada efectiva `commitSnapshot(indexSnapshot, \`upload-beat:${detached.id}\`)`, antes de preparar playback. [Fuente: commit y limpieza del marcador](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/App.tsx#L2405).

## 6. Secuencia de migración

Cada etapa corresponde a uno o varios PR pequeños. Cada PR debe compilar, indicar qué responsabilidad se movió y conservar las pruebas de comportamiento relevantes. Si algo falla por un cambio funcional, se corrige o revierte esa etapa; no se sigue apilando extracciones.

### Etapa 0 — Línea base y pruebas de caracterización

**Trabajo:** fijar el commit inicial, instalar las dependencias del lock con Node/npm compatibles con `package.json`, ejecutar los checks existentes y registrar fallos previos. Inventariar eventos, timers, refs, imports y lectores de código fuente.

Añadir pruebas de caracterización dirigidas a las conexiones que se van a mover: orden de commits, cantidad de llamadas, recuperación, diferimiento de Reload, cancelación de Review, limpieza y routing web/escritorio. Reutilizar fixtures y mecanismos de promesas controladas de las pruebas actuales.

**Cierre:** línea base documentada; escenarios críticos reproducibles; cada comprobación estática de App tiene un destino previsto. Los defectos previos se registran aparte, sin atribuirlos al refactor.

### Etapa 1 — Extraer componentes y helpers de bajo acoplamiento

**Trabajo:** mover los cinco componentes auxiliares con el mismo JSX. Extraer tipos/helpers por dominio: nombres/extensiones, caché, fingerprints, marcadores y decodificación. Separar trasladar de simplificar.

`clearUploadPreviewCache` se mueve a un módulo de caché apropiado. El rastreo actual encuentra su declaración y uso dentro de App, sin consumidores externos en `src`; comprobar de nuevo al implementar antes de eliminar el export antiguo.

**Cierre:** imports actualizados; DOM equivalente; misma apertura/cierre de modales, filtros y sort; pruebas estáticas apuntan a los nuevos archivos pertinentes. Reducción real del primer bloque de App.

### Etapa 2 — Dar un dueño a biblioteca, runtime y selección

**Trabajo:** extraer el estado de biblioteca y runtime; selectores de búsqueda/orden; filtros de tags; selección y reordenamiento interno. Mantener idénticos comparadores y normalización, incluyendo diferencias entre ranking de tags y sugerencias.

Preservar cuándo se actualiza `beatsLatestRef`: hay caminos que lo actualizan inmediatamente dentro del setter y otros mediante efecto. No convertirlos todos de golpe a un mecanismo distinto.

**Cierre:** una única instancia de cada estado; misma selección con Shift, mismo ancla y mismos desempates de rating; reordenamiento por rating solo dentro del mismo rating; rutas web de sort siguen actualizándose.

### Etapa 3 — Artwork y playback

**Trabajo:** extraer hidratación de artwork, preparación, eventos de audio, `handlePlay` y navegación de cola. Mantener `useAudio` donde está internamente; su controlador se monta una sola vez durante la sesión autenticada.

**Cierre:** cache-clear impide que una promesa antigua repueble URLs invalidadas; no hay segundo audio al abrir/cerrar player; siguiente/anterior, cola explícita, repeat, shuffle y final de pista conservan prioridades. Las llamadas web no caen en preparación nativa.

### Etapa 4 — Edición, metadata, proyectos, offline y trash

**Trabajo:** extraer el commit de Drawer junto a sus mapas de deduplicación y el observer que consume esos fingerprints. Después extraer operaciones de assets, proyectos, offline y trash, aprovechando playback y biblioteca ya disponibles.

Mover también callbacks que hoy están escondidos dentro del JSX, especialmente restore de Settings y cierre de Drawer. Mantener las diferencias actuales entre borrado individual y masivo; cualquier unificación va con prueba propia.

**Cierre:** guardar metadata/artwork no duplica commits; Restore no publica un segundo índice cuando la capa nativa ya lo hizo; eliminar el beat actual libera audio; quitar Offline invalida rutas antes de borrar el paquete; proyectos conservan confirmaciones y tratamiento de backups.

### Etapa 5 — Downloads y suscripciones persistentes

**Trabajo:** separar estado del modal, elección de destino, arranque de tarea y escucha de `beatgaler-download-event`. Reutilizar la implementación web de downloads; no reemplazarla con el worker nativo.

**Cierre:** cancelar el selector no inicia nada; cerrar el modal mantiene la tarea; finalización/error se atribuyen al ID y dueño correctos; MP3/WAV/PROJECT/ALL conservan sus marcas y exportación offline.

### Etapa 6 — Cola cloud y pipeline de upload

**Trabajo:** extraer `cloudifyImportedBeats` por partes: cola/estado, journal de recuperación, detalles de error y pipeline asíncrono por beat. Conservar secuencialidad de escritorio y la ruta `platform.cloudData.commitImportedBeat` de web.

Preparar un contrato de solo lectura para conocer candidatos/staging protegidos; inicialmente puede apuntar a las referencias de Review todavía existentes. No necesita mover Review en el mismo PR.

**Cierre:** exactamente la misma frontera durable por beat; retry conserva checkpoints; error posterior al commit no provoca rollback de media durable; la cola drena y dispara la recarga diferida en los caminos actuales. No se introducen commits por render.

### Etapa 7 — Importación, Review y decisiones

**Trabajo:** extraer descubrimiento, estado de Review, Save/Skip/Cancel, Save All y conflictos. Conectar Save con `enqueue` del módulo cloud. Extraer los callbacks de los modales junto con su estado.

Preservar los contadores de ejecución que descartan resultados obsoletos y la barrera de frame antes de preparar Beat 2…N. Mantener la liberación de candidatos web y la protección de staging de escritorio.

**Cierre:** primer beat sin escaneo completo previo; Save All cierra Review de inmediato; duplicados/errores vuelven a revisión al final; Cancel/Skip durante descubrimiento no reintroducen candidatos; los ya guardados sobreviven.

### Etapa 8 — Routing dragdrop

**Trabajo:** mover los listeners HTML y nativo a hooks específicos. Extraer selección de destino/coordenadas y clasificación de archivos. Conectar con importación, artwork, assets y proyectos por acciones; los listeners no realizan commits del índice directamente.

Conservar `htmlDropController`, `nativeDropArbiter`, `nativeExternalImage` y `dropStaging`. El hook nativo puede dividirse entre hit testing, feedback visual y suscripción sin duplicar receptores.

**Cierre:** cada gesto tiene un solo receptor efectivo; se mantienen límites, destinos y prioridades; rutas Finder/Explorer no se convierten en copias HTML; listener desmontado antes de resolver registro asíncrono se desuscribe igualmente.

### Etapa 9 — Arranque, reconexión y SSE

**Trabajo:** ahora que sus dependencias tienen APIs, extraer bootstrap, recuperación inicial, conectividad, SSE y revelado. Compartir helpers de publicación sin fusionar indiscriminadamente los flujos: startup repara/reconcilia, Reload tiene diferimiento, y SSE tiene sus propias guardas.

Mantener `main.tsx` y sus inicializadores durante esta fase. Preservar el orden observable de lecturas de settings, verificación, recuperación, trash offline, autoridad y publicación.

**Cierre:** arranque con/sin caché, offline, mala conexión y autoridad vacía se distinguen; fallos transitorios no borran presentación; SSE y reconnect no duplican listeners ni generan escrituras por hidratar artwork.

### Etapa 10 — Composición final y limpieza controlada

**Trabajo:** completar `AppShell`, header, grid, avisos y hosts de diálogo. `BeatGalerApp` conecta regiones. `useBeatGalerComposition` solo conecta módulos; cualquier algoritmo, timer, llamada de red o recorrido de negocio que quede allí vuelve a su feature.

Eliminar puentes temporales, imports sin uso, helpers sin consumidores y comentarios obsoletos con verificación. No añadir una store global nueva para alcanzar la cifra de líneas.

**Cierre:** `App.tsx` mínimo, `BeatGalerApp` pequeño y sin trasladar el monolito a un hook, provider, `AppContent` o `AppModals`; validación completa y una migración reversible sin cambios de datos.

## 7. Pruebas y adaptación del repositorio

### Pruebas que actualmente dependen de la ubicación del código

La búsqueda local identifica diez archivos de pruebas/regresión que leen App por nombre o por construcción de ruta:

- `tests/component-dom/startupRevealArchitecture.test.ts`.
- `tests/integration/issue97WebRoutingContract.test.ts`.
- `tests/integration/issue97DrawerWebRoutingContract.test.ts`.
- `tests/integration/issue97RuntimeWebFollowup.test.ts`.
- `tests/integration/issue97PlaybackOptimization.test.ts`.
- `scripts/run-regressions.mjs`.
- `scripts/regression-import-native.mjs`.
- `scripts/regression-phase9cd.mjs`.
- `scripts/regression-web-startup-bridge.mjs`.
- `scripts/test-macos-portability.mjs`.

Además hay scripts de mantenimiento que apuntan a App: `fix-app-casing.ps1` y `fix-remaining-build-errors.ps1`.

No basta con concatenar todos los archivos y mantener los mismos `includes()`: eso puede ocultar que una guarda quedó en un módulo que ya no se ejecuta.

La estrategia es actualizar las comprobaciones de estructura al dueño preciso y añadir pruebas de comportamiento para routing, transacciones, eventos y limpieza. Las guardas estáticas útiles permanecen. Los contratos sobre comentarios, nombres internos o dos fragmentos contiguos se sustituyen solo cuando existe una comprobación equivalente más robusta.

Reutilizar especialmente `coreIntegration.test.tsx`, `useAudioDuplicatePlay.test.tsx`, `webPlaybackSortCaller.test.tsx`, `webLibraryReconciledCaller.test.tsx`, pruebas de `beatRuntimeState`, `playbackReadiness`, `webReviewSave`, `webImportCommit`, `webDownloads` y `dragDropLogic`.

[Fuente: guardas de App y estructura](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/tests/component-dom/startupRevealArchitecture.test.ts#L5).

### Comprobaciones por PR

```text
npm run test:typecheck
npm run test:unit:ts
npm run test:component:dom
npm run test:integration
npm run test:regressions
npm run build:web
npm run build
```

Al preparar cada extracción, las pruebas del dominio dan feedback rápido. Para aprobar el PR, ejecutar los checks aplicables anteriores y el CI requerido. `npm run build` también ejecuta el parche WRY existente: no equivale a compilar/ejecutar toda la aplicación nativa.

En los hitos de importación/drop y cierre: `test:e2e:import`, `test:e2e:downloads`, `test:e2e:recovery`, `test:web:smoke` y validación de escritorio/portabilidad en entornos preparados. Ejecutar `npm run check` al cierre; incluye pruebas Rust/cloud a través de `test:fast`. Mantener las comprobaciones propias del workflow web, incluidas las guardas de startup y bound-temp RPC.

`test:fast` no es una suite exclusivamente ligera de frontend: incluye Rust, cloud, DOM, integración y regresiones. Registrar versiones, comandos, salidas y fallos previos; no marcar como comprobado un escenario que solo pasó por análisis estático.

### Escenarios de aceptación funcional

- Startup con caché válida, sin caché, caché inválida, autoridad vacía, autoridad fallida y red desconectada; conservar la diferencia entre vacío confirmado y desconocido.
- Dos beats compartiendo staging: guardar uno, omitir/cancelar el otro mientras sigue el upload; reiniciar tras commit y antes/después de limpiar el marcador.
- Upload falla en MASTER, WAV/proyecto, metadata, índice o preparación posterior; retry conserva lo durable.
- Pulsar Reload durante upload; simular además SSE/reconexión concurrentes para caracterizar sus reglas actuales.
- Editar metadata/artwork y restaurar Trash: comprobar orden y cantidad de commits, no solo el aspecto visual.
- Play rápido repetido; cambiar de beat mientras se prepara; clear cache con promesa pendiente; siguiente/anterior; cola explícita; repeat/shuffle; borrar el beat actual.
- Available Offline: crear, reiniciar sin red, exportar y eliminar disponibilidad. Eliminar sin red registra intención y reconcilia al volver.
- Exportar cada tipo; cancelar destino; cerrar/reabrir modal durante descarga; terminar/fallar una tarea mientras hay otra operación de audio.
- Windows Explorer, macOS Finder, artwork de navegador/Pinterest, Drawer y tarjeta; una recepción por gesto. Usar más de un factor de escala para coordenadas nativas.
- Web: un beat por drop, edición y descarga web, ausencia de invocaciones nativas en esos caminos, cambio de sort y página con más de 14 beats.
- Selección Shift, filtros incluidos/excluidos y reordenamiento con ratings iguales/diferentes; mantener el comportamiento de búsqueda existente.
- Misma estructura de DOM, roles/labels efectivos, navegación por teclado, portales, scroll y revelado de tarjetas tras la extracción visual.

## 8. Mejoras fuera de App y su prioridad

### Necesarias para una migración fiable

**Pruebas acopladas al texto de App.** Adaptarlas con cada extracción, conservando evidencia funcional. No deshabilitar suites para que pase el refactor.

**DOM modificado desde `LibraryUxBridge`.** El bridge identifica regiones por texto, posición de hijos y estructura, y usa `MutationObserver`. Extraer a componentes puede ser seguro si el DOM queda igual; envolver todo en nuevos contenedores puede romper estilos, labels y handlers. Tras terminar la migración, incorporar esos atributos y comportamientos a los componentes React y retirar el bridge gradualmente con pruebas de accesibilidad. [Fuente](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/features/library/LibraryUxBridge.tsx#L79).

**Instrucciones históricas contradictorias.** Actualizar comentarios sobre commit por lote, cooking y timers solamente después de verificar consumidores. Los comentarios no pueden dictar un cambio que contradiga la implementación efectiva.

### Segunda migración: deuda relevante que conviene abordar después

**`UploadModal.tsx`, 2,012 líneas.** Mezcla pasos visuales, presets, validación de navegación, jobs, programación y publicación a YouTube. Separar `publishing/steps`, presets, scheduler y controlador del wizard. App solo necesita el estado de apertura y selección inicial. Preservar la continuidad de jobs cuando se cierra el modal.

**`AccountGate.tsx`, 642 líneas, y `lib/tauri.ts`, 1,358.** La capa cloud importa funciones de autenticación desde un componente UI. Extraer servicios de sesión/API desde `AccountGate` y separar la fachada nativa por dominios es deseable, pero tiene una dependencia obligatoria: el plugin `productiveTrustBoundaryPlugin` de Vite reemplaza texto exacto en ambos archivos y rechaza la compilación si sus anclas desaparecen.

Antes de reorganizarlos: comprobar equivalencia entre código fuente y código efectivo transformado; convertir las reglas vigentes de origen/API y parser local en módulos explícitos; actualizar el transform y sus guardas en el mismo cambio; verificar bundles web y escritorio. No eliminar esa transformación como una simple limpieza. Mientras tanto, conservar ambos archivos y la inicialización única del puente nativo. [Fuente: transform de Vite](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/vite.config.ts#L38).

**`Drawer.tsx`, 904 líneas.** Separar edición, selección de assets, guardado web/escritorio y presentación; primero extraer su coordinación de App. No mover simultáneamente ambas mitades de una transacción sin cobertura.

**`webTransport.worker.ts`, 1,287 líneas.** Evaluar una revisión independiente de protocolo, conexión y scheduler. Su tamaño lo convierte en candidato, pero este análisis no demuestra que deba modificarse para reducir App.

### Hallazgos para reproducir antes de corregir

- `handleRemoveBulk` construye su resultado a partir de `beats` capturado antes de varios `await`; el borrado individual lee `beatsLatestRef` al construir la biblioteca siguiente. Investigar borrado masivo concurrente con importación/SSE: existe riesgo de publicar una vista obsoleta. No se ha reproducido aquí.
- `libraryStateManager` serializa operaciones, pero `commitSnapshot` captura el snapshot antes de entrar en la sección exclusiva. Serializar no implica rebasar un snapshot sobre cambios posteriores. Probar operaciones concurrentes antes de cambiar esa semántica. [Fuente](https://github.com/magosouljah/BeatGaler/blob/f5dd24de6049453c735c4daf34066065c5773280/src/lib/libraryStateManager.ts#L69).
- `refreshOpenableCloudProjects` depende de `beats` completo; hidratación visual puede provocar consultas repetidas. Medir y luego limitar a cambios relevantes de proyectos.
- `formatCloudBytes`, `addBeats` y `updateExistingBeatFromFolder` aparecen sin consumidores en App. Varias refs de startup solo reciben asignaciones; `cloudLibraryTimerRef` no tiene un timer asignado en este archivo. Confirmar por análisis de referencias y typecheck antes de retirarlas.
- `noUnusedLocals` y `noUnusedParameters` están desactivados. Activarlos como diagnóstico de limpieza o por un cambio dedicado después de evaluar el volumen de deuda; no añadir cientos de cambios ajenos al primer PR.

Estas correcciones deben tener cambios separados de la extracción mecánica. Si una prueba revela un defecto, registrar el caso, corregirlo de forma aislada y actualizar la línea base antes de continuar.

## 9. Definición de terminado

- `App.tsx` únicamente importa y compone la entrada con la misma guarda de plataforma.
- `BeatGalerApp` presenta las regiones principales y conecta APIs pequeñas.
- No existe un hook/provider nuevo que concentre otra vez todos los estados y handlers.
- Cada estado, listener, timer, promesa compartida y recurso temporal tiene un dueño y el mismo ciclo de vida comprobado.
- Las features no importan la raíz; los adaptadores existentes siguen resolviendo web/escritorio.
- No se cambian claves de almacenamiento, formatos, endpoints, nombres de comandos nativos, capacidades o contratos de eventos durante el traslado.
- La UI mantiene DOM efectivo, orden, selección, flujos de modal y comportamiento de audio.
- Los checks y escenarios ejecutados están documentados, con plataformas realmente verificadas y limitaciones explícitas.
- Cada etapa se puede revertir mediante su cambio de código, sin una migración de datos asociada.

**Primer paso de implementación recomendado:** línea base + extracción de los cinco componentes auxiliares y helpers aislados, con sus guardas actualizadas. Después, biblioteca/runtime y playback proporcionan las APIs que permiten desmontar los flujos más acoplados.
