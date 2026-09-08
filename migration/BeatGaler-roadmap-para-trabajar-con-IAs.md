**Objetivo:** organizar el código de BeatGaler y dejar `App.tsx` como una entrada pequeña, conservando cómo funciona la aplicación.

**Estado actual de referencia:** las tareas 1.1–3.3 están terminadas. La siguiente tarea pendiente es 3.4. El estado operativo de cada ejecución se toma de `BeatGaler-agent-state.md` y debe contrastarse con Git, código, tests y este roadmap.

**Referencia técnica:** `BeatGaler-plan-de-migracion.md`. Entrega ambos documentos a la IA que vaya a trabajar. Este roadmap explica qué hacer y en qué orden; el plan completo contiene las reglas y referencias técnicas.

El análisis original corresponde a la rama `integration-v0.8.0-alpha.1`, commit `f5dd24de6049453c735c4daf34066065c5773280`. La IA debe comprobar el código actual antes de comenzar: las líneas y ubicaciones cambiarán durante el trabajo.

## Cómo usar este roadmap

1. Empieza por **1.1** y sigue las tareas en orden.
    
2. Encarga **una tarea por vez**. Una parte contiene varias tareas; no hace falta terminar una parte entera en una conversación.
    
3. La IA implementa, comprueba el cambio y registra el resultado.
    
4. Cuando haga falta probar la app, pídele instrucciones concretas: qué abrir, qué pulsar y qué debería pasar.
    
5. Marca la tarea como terminada cuando se hayan comprobado sus criterios. Si falta una prueba necesaria, déjala como **Por verificar**.
    
6. Para continuar con otra IA, entrega los dos planes, el código actualizado y el último registro de avance.
    

**Flujo autónomo:** `BeatGaler-agent-state.md` indica la tarea actual. La IA debe comprobarla contra este roadmap, el registro y el estado real del repositorio antes de trabajar. Al cerrar una tarea, actualiza la casilla correspondiente, agrega el registro al final y deja la siguiente tarea pendiente en `BeatGaler-agent-state.md`.

### Estados de una tarea

- **Pendiente:** todavía no comenzó.
    
- **En curso:** se está trabajando en ella.
    
- **Por verificar:** el cambio está hecho, pero falta una comprobación necesaria.
    
- **Terminada:** cumple sus comprobaciones y tiene un registro del resultado.
    

La casilla `[ ]` se cambia por `[x]` únicamente al terminar. Guarda los otros estados en el registro de avance del final.

## Reglas para todas las tareas

- Conservar comportamiento, apariencia, formatos guardados y diferencias entre web y escritorio.
    
- Aprovechar los módulos existentes. Evitar crear otra copia del mismo estado o del mismo servicio.
    
- Mover juntos una operación y los datos que necesita para seguir funcionando. Conservar el orden de efectos, tiempos y limpieza de tareas en segundo plano.
    
- Adaptar las pruebas afectadas por el traslado. Algunas buscan código dentro de `App.tsx`; no desactivarlas para conseguir un resultado verde.
    
- Separar de la migración los bugs y mejoras adicionales. Registrarlos; si impiden avanzar, resolverlos en un cambio identificable antes de continuar.
    
- Hacer una revisión del cambio al cerrar cada tarea: debe ser fácil explicar qué responsabilidad salió de App y dónde quedó.
    
- Seguir los checks de la sección 7 del plan completo. Durante el trabajo, ejecutar los del área afectada; antes de cerrar una parte, comprobar tipos, pruebas aplicables y compilaciones web/escritorio. Una compilación no sustituye una prueba real de la app.
    

**Vocabulario breve:** “extraer” significa mover código y conectar sus llamadas; “estado” son los datos que la app recuerda mientras funciona; “índice cloud” es la lista autoritativa de beats; “staging” son las copias temporales que pueden compartir varias importaciones.

## Vista general

- **Parte 1. Preparar:** saber desde dónde empezamos y qué funciona.
    
- **Parte 2. Componentes visuales:** sacar ventanas, buscador y menús.
    
- **Parte 3. Biblioteca y selección:** organizar beats, filtros y orden.
    
- **Parte 4. Reproducción:** separar portadas, audio y cola.
    
- **Parte 5. Acciones sobre beats:** edición, proyectos, offline y papelera.
    
- **Parte 6. Descargas y subidas:** separar tareas de fondo y recuperación.
    
- **Parte 7. Importación:** organizar Review, guardado y conflictos.
    
- **Parte 8. Drag & drop:** separar recepción y destino de archivos.
    
- **Parte 9. Arranque y conexión:** organizar sesión, recarga y sincronización.
    
- **Parte 10. Cierre:** dejar la composición mínima y verificar el conjunto.
    

---

## Parte 1 — Preparar el trabajo

**Resultado:** tener una referencia comprobable para saber si un cambio rompió algo.

### [x] 1.1 — Confirmar el punto de partida

- **Hacer:** comprobar rama, commit y estado versionado en GitHub; comparar el estado actual con el análisis original y preparar una rama de trabajo conservando los cambios existentes.
    
- **Archivos:** repositorio y documentos de planificación. Todavía no mover código de la app.
    
- **Conservar:** el trabajo previo y una referencia recuperable del inicio.
    
- **Termina cuando:** quedan registrados rama, commit y diferencias relevantes respecto al plan.
    

### [x] 1.2 — Comprobar cómo está la app hoy

- **Hacer:** instalar las dependencias del proyecto y ejecutar sus comprobaciones iniciales. Documentar qué pasa y qué ya falla.
    
- **Archivos:** consultar `package.json`, lockfile, scripts y pruebas existentes. Registrar resultados.
    
- **Conservar:** las versiones y configuración previstas por el proyecto.
    
- **Termina cuando:** existe una lista de comprobaciones ejecutadas, resultados y pruebas pendientes por falta de entorno. Un fallo previo debe quedar identificado.
    

### [x] 1.3 — Preparar las pruebas de los flujos delicados

- **Hacer:** revisar cobertura existente y cubrir las conexiones que vamos a mover: uploads, Review, Reload, audio, recuperación y separación web/escritorio.
    
- **Archivos:** `tests/`, scripts de regresión y registro de avance. Usar las referencias del plan completo.
    
- **Conservar:** las garantías de las pruebas que hoy leen literalmente App.
    
- **Termina cuando:** los flujos críticos tienen comprobaciones concretas y sabemos qué pruebas se adaptarán con cada extracción. Las comprobaciones específicas se completan también al trabajar en su tarea.
    

## Parte 2 — Sacar componentes visuales

**Resultado:** reducir App con los movimientos más fáciles de comprobar.

### [x] 2.1 — Separar las dos ventanas auxiliares

- **Hacer:** extraer `CloudFilesModal` y `BeatFileDropModal`.
    
- **Archivos:** `App.tsx`; destinos en `features/downloads/components/` y `features/dragdrop/components/`; pruebas afectadas.
    
- **Conservar:** estructura visual, portales, botones, cierre y opciones disponibles. La lógica de operaciones permanece conectada como hoy.
    
- **Termina cuando:** ambas ventanas se abren, funcionan y cierran igual, y sus componentes ya viven fuera de App.
    

### [x] 2.2 — Separar buscador y menús

- **Hacer:** extraer `SearchBar`, `SortMenu` y `TagColorMenu`.
    
- **Archivos:** `App.tsx`; componentes de `features/library/` y `features/tags/`; pruebas afectadas.
    
- **Conservar:** la estructura del HTML que utiliza `LibraryUxBridge`, foco, teclado y apertura/cierre.
    
- **Termina cuando:** buscar, elegir orden y abrir el menú de colores funcionan como antes.
    

### [x] 2.3 — Separar las funciones auxiliares

- **Hacer:** ubicar por responsabilidad las funciones de rutas, caché, comparación de metadata, marcadores de uploads y decodificación de portadas.
    
- **Archivos:** `App.tsx` y helpers de library, cloud, artwork y dragdrop. Comprobar consumidores de `clearUploadPreviewCache`.
    
- **Conservar:** mismas claves de almacenamiento, formatos y resultados; mover sin simplificar reglas.
    
- **Termina cuando:** los helpers tienen un destino claro y sus consumidores/pruebas apuntan allí.
    

## Parte 3 — Organizar biblioteca y selección

**Resultado:** que cada grupo de datos tenga un dueño identificable.

### [x] 3.1 — Separar el estado de la biblioteca

- **Hacer:** extraer el manejo de `beats`, lectura de su versión actual y caché de presentación.
    
- **Archivos:** `App.tsx`, `features/library/useLibraryState.ts` y helpers de caché.
    
- **Conservar:** una sola biblioteca en memoria y los momentos actuales de actualización de `beatsLatestRef`. La caché no puede convertirse en autoridad cloud.
    
- **Termina cuando:** todos los consumidores usan la misma biblioteca; carga y actualizaciones conservan su comportamiento.
    

### [x] 3.2 — Separar los estados de operación por beat

- **Hacer:** extraer el registro que indica si un beat está subiendo, reproduciéndose, descargándose o eliminándose.
    
- **Archivos:** `App.tsx`, `features/state/useBeatRuntimeRegistry.ts`; reutilizar `beatRuntimeState.ts`.
    
- **Conservar:** transiciones existentes y estados pendientes de papelera aunque la tarjeta ya haya desaparecido.
    
- **Termina cuando:** cada operación sigue actualizando el mismo registro y sus pruebas pasan.
    

### [x] 3.3 — Separar búsqueda, filtros y etiquetas

- **Hacer:** extraer búsqueda, ordenación, filtros incluidos/excluidos y cálculo de etiquetas sugeridas.
    
- **Archivos:** `App.tsx`, selectores de `features/library/` y `features/tags/`.
    
- **Conservar:** comparadores, normalización y desempates actuales. Mantener la conexión web entre sort y preparación de playback.
    
- **Termina cuando:** las mismas entradas producen los mismos beats y en el mismo orden.
    

### [x] 3.4 — Separar selección y reordenamiento

- **Hacer:** extraer selección individual, Shift, Select All, limpieza de selección y arrastre para ordenar tarjetas.
    
- **Archivos:** `App.tsx`, `features/selection/useBeatSelection.ts`, `features/library/useLibraryReorder.ts`.
    
- **Conservar:** selección por rango, ancla y límites del reordenamiento cuando se ordena por rating.
    
- **Termina cuando:** seleccionar, deseleccionar, filtrar y reordenar mantienen los resultados actuales.
    

## Parte 4 — Separar reproducción

**Resultado:** que audio y portadas tengan su propia lógica, sin depender de qué ventana esté abierta.

### [x] 4.1 — Separar la carga de portadas

- **Hacer:** extraer hidratación, decodificación y reutilización de portadas.
    
- **Archivos:** `App.tsx`, `features/artwork/useArtworkHydration.ts` y helpers existentes.
    
- **Conservar:** cargar una imagen para mostrarla no equivale a editarla ni debe generar un commit cloud.
    
- **Termina cuando:** las portadas aparecen igual y una recarga visual no dispara guardados adicionales.
    

### [x] 4.2 — Separar preparación y control del audio

- **Hacer:** extraer preparación, URLs temporales, invalidación de caché, eventos y `handlePlay`.
    
- **Archivos:** `App.tsx`, controladores de `features/playback/`; conservar internamente `hooks/useAudio.ts`.
    
- **Conservar:** un solo audio, bloqueos durante preparación y rutas distintas web/escritorio.
    
- **Termina cuando:** Play repetido, cambio rápido de beat y limpiar caché durante una preparación no producen audio duplicado ni reutilizan rutas invalidadas.
    

### [ ] 4.3 — Separar la cola y navegación

- **Hacer:** extraer cola del usuario, siguiente/anterior, shuffle, repeat y avance al terminar una pista.
    
- **Archivos:** `App.tsx`, `features/playback/usePlaybackQueue.ts`.
    
- **Conservar:** prioridad de la cola explícita, comportamiento con filtros y avance único por final de pista.
    
- **Termina cuando:** todos esos controles funcionan igual y eliminar un beat no deja referencias reproducibles inválidas.
    

## Parte 5 — Separar acciones sobre beats

**Resultado:** localizar con facilidad dónde se edita, actualiza o elimina un beat.

### [ ] 5.1 — Separar guardado de metadata y artwork

- **Hacer:** extraer edición y commit del Drawer junto con el mecanismo que evita guardados duplicados y el observer de metadata de escritorio.
    
- **Archivos:** `App.tsx`, `features/edit/`; mantener conectado `Drawer.tsx` sin reorganizar su interior todavía.
    
- **Conservar:** orden de guardado, debounce y condiciones de web/escritorio.
    
- **Termina cuando:** una edición produce las mismas escrituras que antes y no se guarda dos veces por cambiar de módulo.
    

### [ ] 5.2 — Separar reemplazo de archivos de un beat

- **Hacer:** extraer las operaciones para actualizar MASTER, WAV y otros assets admitidos, incluyendo sus estados de trabajo.
    
- **Archivos:** `App.tsx`, `features/edit/useBeatAssetUpdates.ts`; mantener los servicios existentes.
    
- **Conservar:** confirmaciones, bloqueo del beat, preparación del nuevo MASTER y limpieza de archivos temporales.
    
- **Termina cuando:** reemplazar o cancelar un archivo mantiene el resultado actual, incluido el tratamiento de errores.
    

### [ ] 5.3 — Separar proyectos

- **Hacer:** extraer apertura, subida, actualización, reemplazo e indicadores de disponibilidad de proyectos.
    
- **Archivos:** `App.tsx`, `features/projects/`.
    
- **Conservar:** reglas de PROJECT ZIP, carpetas Backup/Backups, avisos y disponibilidad por plataforma.
    
- **Termina cuando:** abrir, actualizar y reemplazar proyectos funciona igual y sus indicadores se actualizan.
    

### [ ] 5.4 — Separar Available Offline

- **Hacer:** extraer creación y eliminación de paquetes offline.
    
- **Archivos:** `App.tsx`, `features/offline/useOfflineAvailability.ts`, conexiones con playback y biblioteca.
    
- **Conservar:** diferencia entre paquete durable y caché temporal de audio; invalidar rutas en los puntos actuales al quitar disponibilidad.
    
- **Termina cuando:** un paquete funciona después de reiniciar sin red y quitarlo conserva la conducta actual online/offline.
    

### [ ] 5.5 — Separar papelera y restauración

- **Hacer:** extraer borrado individual/masivo y el callback de restauración que hoy vive dentro de Settings.
    
- **Archivos:** `App.tsx`, `features/trash/useTrashActions.ts`; conservar servicios de papelera existentes.
    
- **Conservar:** confirmaciones, audio del beat eliminado e instrucciones pendientes de eliminación offline. No publicar un segundo índice al restaurar si la capa nativa ya lo hizo.
    
- **Termina cuando:** borrar y restaurar funciona igual online/offline y los beats eliminados no reaparecen por una recarga indebida.
    

### [ ] 5.6 — Separar el renombrado global de tags

- **Hacer:** extraer operación, estados de progreso/error y diálogo de renombrado.
    
- **Archivos:** `App.tsx`, `features/tags/useTagRename.ts`, `TagRenameDialog.tsx` y servicios existentes.
    
- **Conservar:** orden de metadata, actualización de filtros/colores y recuperación de la operación.
    
- **Termina cuando:** renombrar una etiqueta actualiza los mismos beats y mantiene feedback, cancelación previa y errores.
    

## Parte 6 — Separar descargas y subidas

**Resultado:** las operaciones de fondo continúan correctamente aunque se cierren ventanas.

### [ ] 6.1 — Separar las descargas de exportación

- **Hacer:** extraer selección de destino, arranque de descargas, seguimiento de tareas y listener de resultados.
    
- **Archivos:** `App.tsx`, `features/downloads/`; reutilizar `webDownloads.ts` donde corresponde.
    
- **Conservar:** MP3/WAV/PROJECT/ALL, exportación desde paquetes offline y atribución del resultado a la tarea correcta.
    
- **Termina cuando:** cancelar el destino no descarga nada y cerrar el modal no interrumpe una descarga iniciada.
    

### [ ] 6.2 — Separar recuperación y errores de uploads

- **Hacer:** completar la extracción del registro de subidas interrumpidas y los detalles de error. Mantener sus llamadas desde los puntos actuales.
    
- **Archivos:** `App.tsx`, `features/cloud/interruptedUploadJournal.ts`, `uploadErrorDetails.ts`.
    
- **Conservar:** comprobar el índice cloud antes de eliminar una subida interrumpida; si no puede comprobarse, diferir la limpieza.
    
- **Termina cuando:** una subida confirmada permanece intacta tras reiniciar, y los errores conservan información útil.
    

### [ ] 6.3 — Separar el proceso de subida de un beat

- **Hacer:** extraer la secuencia asíncrona de escritorio como una unidad con entradas y acciones explícitas; el coordinador actual sigue llamándola.
    
- **Archivos:** `App.tsx`, `features/cloud/desktopBeatUploadPipeline.ts`.
    
- **Conservar:** orden de MASTER/WAV/proyecto/metadata, confirmación del índice por beat y limpieza del marcador antes de preparar audio.
    
- **Termina cuando:** retry respeta archivos ya subidos y un fallo de reproducción posterior no elimina una subida durable.
    

### [ ] 6.4 — Separar la cola de uploads

- **Hacer:** extraer cola, IDs activos, reintentos y finalización; conectar el proceso de 6.3 y la ruta web existente.
    
- **Archivos:** `App.tsx`, `features/cloud/useCloudUploadQueue.ts` y conexiones con Reload/Review.
    
- **Conservar:** secuencialidad de escritorio, protección de staging compartido y diferimiento de Reload. Mientras Review siga en App, consultar sus datos mediante una conexión pequeña de lectura.
    
- **Termina cuando:** varios uploads conservan su orden y, al finalizar, se ejecuta la recarga pendiente en los caminos actuales.
    

## Parte 7 — Separar importación y Review

**Resultado:** poder entender y modificar la revisión de importaciones sin entrar en la lógica cloud.

### [ ] 7.1 — Separar Review y sus acciones básicas

- **Hacer:** extraer candidatos, posición actual y acciones Save, Skip y Cancel; conectar Save con la cola de uploads.
    
- **Archivos:** `App.tsx`, `features/import/useImportSession.ts`, `useImportReview.ts`, `ImportReviewHost.tsx`.
    
- **Conservar:** candidatos fuera de la biblioteca hasta Save; Cancel mantiene lo ya guardado y las fuentes que siguen en uso.
    
- **Termina cuando:** guardar, omitir y cancelar afectan exactamente a los mismos beats que antes.
    

### [ ] 7.2 — Separar descubrimiento incremental

- **Hacer:** extraer búsqueda/preparación progresiva de beats desde rutas y carpetas.
    
- **Archivos:** `App.tsx`, `features/import/useImportDiscovery.ts`.
    
- **Conservar:** mostrar la primera revisión antes de terminar todo el escaneo; descartar resultados de una importación cancelada o reemplazada.
    
- **Termina cuando:** un lote grande permite revisar pronto el primer beat y Cancel durante el descubrimiento no reabre candidatos antiguos.
    

### [ ] 7.3 — Separar Save All y conflictos

- **Hacer:** extraer guardado del resto del lote y callbacks de decisiones/duplicados/conflictos.
    
- **Archivos:** `App.tsx`, `features/import/useImportSaveAll.ts`, host de Review y conexiones de los modales existentes.
    
- **Conservar:** Save All cierra la revisión inmediatamente; pendientes con conflicto se revisan después; staging no se elimina mientras siga utilizándose.
    
- **Termina cuando:** se guardan los candidatos válidos y los conflictos quedan disponibles para resolverlos.
    

### [ ] 7.4 — Separar la entrada de importación web

- **Hacer:** extraer la recepción de archivos del navegador y su entrada a Review, reutilizando `platform.importer` y el commit web.
    
- **Archivos:** `App.tsx`, `features/import/useBrowserImport.ts` y módulos web existentes.
    
- **Conservar:** un beat por gesto, carga de metadata y liberación de candidatos al omitir/cancelar.
    
- **Termina cuando:** importar, guardar y cancelar funcionan en web sin invocaciones nativas.
    

## Parte 8 — Separar drag & drop

**Resultado:** que la recepción del gesto se limite a decidir qué acción debe ejecutarse.

### [ ] 8.1 — Separar detección del destino

- **Hacer:** extraer clasificación de archivos y localización del destino: galería, tarjeta, portada o campo del Drawer.
    
- **Archivos:** `App.tsx`, `features/dragdrop/nativeDropTargets.ts` y helpers existentes.
    
- **Conservar:** prioridad de destinos, atributos `data-*`, coordenadas y escala de pantalla.
    
- **Termina cuando:** los mismos archivos y coordenadas se dirigen a las mismas acciones.
    

### [ ] 8.2 — Separar recepción HTML y navegador

- **Hacer:** mover la conexión con `htmlDropController` a un hook que llama a importación, artwork y actualización de assets.
    
- **Archivos:** `App.tsx`, `features/dragdrop/useHtmlLibraryDrop.ts` y controller existente.
    
- **Conservar:** fallback de fuentes de imágenes y condiciones de instalación por plataforma; Windows mantiene su receptor nativo.
    
- **Termina cuando:** los gestos HTML admitidos funcionan una sola vez y las imágenes de navegador no se interpretan como beats.
    

### [ ] 8.3 — Separar recepción nativa

- **Hacer:** extraer listener de Tauri, feedback de arrastre y conexión con el arbitraje existente.
    
- **Archivos:** `App.tsx`, `features/dragdrop/useNativeLibraryDrop.ts`; conservar arbiter, sentinelas y staging existentes.
    
- **Conservar:** rutas originales de Explorer/Finder, límites de archivos y desuscripción aunque el registro del listener termine tarde.
    
- **Termina cuando:** se comprueban los destinos nativos, un receptor efectivo por gesto y limpieza de listeners. Registrar por separado las plataformas probadas.
    

## Parte 9 — Separar arranque y conexión

**Resultado:** comprender qué sucede al abrir, recargar, desconectar y reconectar la app.

### [ ] 9.1 — Separar sesión y ajustes

- **Hacer:** extraer estado de ajustes/conexión/verificación, cambios de preferencias, cursor y acción de desconexión.
    
- **Archivos:** `App.tsx`, `features/session/` y conexiones con Settings.
    
- **Conservar:** conexión a internet y verificación cloud como datos distintos; limpieza actual de audio y presentación al desconectar.
    
- **Termina cuando:** los flujos restantes consumen una sola sesión y Settings conserva su conducta.
    

### [ ] 9.2 — Separar Reload

- **Hacer:** extraer recarga manual, reintentos y recepción de recarga diferida usando la actividad de la cola cloud.
    
- **Archivos:** `App.tsx`, `features/library/useLibraryReload.ts`.
    
- **Conservar:** Reload durante upload se difiere; un fallo de autoridad conserva la galería disponible.
    
- **Termina cuando:** Reload funciona tanto con uploads activos como sin ellos y mantiene su feedback visual.
    

### [ ] 9.3 — Separar el arranque inicial

- **Hacer:** extraer lectura de ajustes, verificación, recuperación y carga de biblioteca inicial.
    
- **Archivos:** `App.tsx`, `features/startup/useStartupBootstrap.ts`; conservar inicializadores de `main.tsx`.
    
- **Conservar:** orden de operaciones y distinción entre caché, biblioteca vacía confirmada y autoridad desconocida.
    
- **Termina cuando:** abrir con/sin caché, sin red y con fallo temporal cloud mantiene los resultados de la línea base.
    

### [ ] 9.4 — Separar reconexión y eventos cloud

- **Hacer:** extraer listeners online/offline y eventos del servidor —SSE— que actualizan la biblioteca.
    
- **Archivos:** `App.tsx`, `features/session/useConnectivity.ts`, `features/cloud/useCloudLibraryEvents.ts`.
    
- **Conservar:** backoff, verificación, reconciliación de papelera offline y condiciones particulares de cada flujo.
    
- **Termina cuando:** desconectar/reconectar y recibir cambios remotos no duplica listeners ni modifica las reglas de commits.
    

### [ ] 9.5 — Separar la aparición de tarjetas

- **Hacer:** extraer revelado progresivo y retirada del indicador de arranque.
    
- **Archivos:** `App.tsx`, `features/startup/useLibraryReveal.ts`, `startupLoader.ts`.
    
- **Conservar:** lugar reservado de cada tarjeta; mostrar según título/artwork sin esperar todo el audio; validar paquetes offline antes de revelarlos.
    
- **Termina cuando:** galería, carga y estado vacío aparecen en las mismas condiciones y sin nuevas desapariciones/reapariciones.
    

## Parte 10 — Cerrar la migración

**Resultado:** una entrada pequeña y módulos que se pueden mantener por separado.

### [ ] 10.1 — Extraer la estructura visual restante

- **Hacer:** separar header, galería, avisos, barra de selección y regiones de diálogos/player; mover los callbacks restantes a sus módulos.
    
- **Archivos:** `App.tsx`, `app/AppShell.tsx`, componentes por feature, atajos de `app/useAppShortcuts.ts` y apertura de YouTube en publishing.
    
- **Conservar:** DOM efectivo, keys, portales, teclado y montaje permanente de tareas de fondo.
    
- **Termina cuando:** App deja de contener grandes bloques de interfaz y la app se ve y se usa igual.
    

### [ ] 10.2 — Dejar la composición mínima

- **Hacer:** dejar `App.tsx` como entrada; crear/completar `app/BeatGalerApp.tsx` y conexiones entre módulos.
    
- **Archivos:** `App.tsx`, `app/BeatGalerApp.tsx`, `app/useBeatGalerComposition.ts`.
    
- **Conservar:** una sola ruta de autenticación por plataforma. Evitar concentrar otra vez toda la lógica dentro de un hook o provider.
    
- **Termina cuando:** se entiende la estructura leyendo la raíz. Orientación: App 5–15 líneas, BeatGalerApp 40–100; los números no justifican ocultar lógica ni comprimirla.
    

### [ ] 10.3 — Retirar restos y conexiones temporales

- **Hacer:** comprobar y eliminar imports/helpers sin consumidores, conexiones de transición y comentarios obsoletos. Revisar dependencias entre módulos.
    
- **Archivos:** los afectados por la migración y sus pruebas/documentación.
    
- **Conservar:** funcionalidades y contratos públicos; cada eliminación debe justificarse con referencias o comprobaciones.
    
- **Termina cuando:** cada responsabilidad tiene un dueño, las features no importan la raíz y no quedan piezas duplicadas por la transición.
    

### [ ] 10.4 — Comprobar el resultado completo

- **Hacer:** ejecutar validación final del plan completo y recorrer los flujos principales en los entornos disponibles. Comparar con la línea base.
    
- **Archivos:** pruebas, registro de resultados y documentación final; corregir regresiones atribuibles a la migración.
    
- **Conservar:** mismos comportamientos de usuario y contratos de datos/cloud.
    
- **Termina cuando:** todas las tareas tienen evidencia, las plataformas comprobadas están identificadas y no quedan verificaciones necesarias pendientes. Solo entonces marcar terminada la migración.
    

---

## Mejoras posteriores — Fuera de las diez partes

Estas mejoras se planifican después. Ninguna se marca terminada por haber reducido App.

- **E1. Dividir** `**UploadModal.tsx**`**:** separar pasos, presets, programación y publicación a YouTube.
    
- **E2. Simplificar** `**LibraryUxBridge**`**:** incorporar a React sus estilos, atributos y comportamientos, conservando accesibilidad.
    
- **E3. Separar servicios de** `**AccountGate**` **y dividir** `**lib/tauri.ts**`**:** resolver primero, en el mismo cambio, las transformaciones de texto exacto y pruebas de `vite.config.ts`.
    
- **E4. Dividir el interior de** `**Drawer.tsx**`**:** separar edición, assets y presentación después de estabilizar su conexión con App.
    
- **E5. Investigar concurrencia:** reproducir posibles problemas de borrado masivo y snapshots obsoletos antes de corregirlos.
    
- **E6. Medir consultas repetidas de proyectos:** optimizar únicamente después de confirmar trabajo redundante.
    

El worker de transporte web puede revisarse por separado si hace falta; su tamaño no lo convierte en una dependencia de esta migración.

## Instrucción para copiar a la IA

La tarea no se proporciona manualmente: se toma de `BeatGaler-agent-state.md` y se valida contra este roadmap, el registro y el repositorio real.

> Trabaja en BeatGaler y completa únicamente la tarea actual indicada por `BeatGaler-agent-state.md`. Usa “BeatGaler-plan-de-migracion.md” como referencia técnica.
> 
> Primero revisa el código actual, las instrucciones del repositorio, `BeatGaler-agent-state.md`, este roadmap y el registro de avance. Comprueba que las tareas previas necesarias estén completas. Si la tarea ya está hecha, verifica su resultado y evita repetir cambios.
> 
> Implementa la extracción conservando comportamiento, apariencia, contratos y diferencias entre web y escritorio. Reutiliza los módulos existentes y adapta las pruebas afectadas. Registra las mejoras ajenas al alcance por separado.
> 
> Ejecuta las comprobaciones de esta tarea y los checks aplicables del plan completo. Si necesitas una prueba manual, deja los pasos exactos y el resultado esperado en el registro. Identifica cualquier comprobación que no puedas ejecutar y su motivo.
> 
> Al terminar, actualiza estos documentos: marca únicamente con `[x]` la tarea realmente Terminada en este roadmap; agrega el registro completo de la tarea al final de `Registro-de-avance.md`; y actualiza `BeatGaler-agent-state.md` con el estado real y la siguiente tarea. Marca Terminada solo si cumple sus criterios; de lo contrario usa Por verificar o En curso. Completa como máximo una tarea y no inicies automáticamente la siguiente.

## Registro de avance para continuar con otra IA

Mantén este registro al final del documento, agregando una entrada por tarea. Incluye una referencia al cambio —commit si existe, o diff/archivos pendientes— para que la siguiente IA sepa qué recibió.

```Formato Obligatorio
Tarea: [ID y título]
Estado: [Pendiente / En curso / Por verificar / Terminada]
Fecha:
Rama y commit de partida:
Referencia del cambio realizado:

Qué cambió:
Archivos afectados:
Comprobaciones ejecutadas y resultado:
Pruebas manuales y plataforma:
Pendientes o fallos previos:
Conexiones temporales que quedan:
Siguiente tarea:
```

