# Encargo a la IDE — integrar C12-B Infinite Scroll sin pisar trabajo local

## Contexto

El usuario aprobó expresamente que la Gallery POSTGRES sea una sola vista continua con **infinite scroll virtualizado**, y que al alejarse los beats previos se desmonten mientras se cargan los siguientes. Registro oficial: [C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md).

La IDE previamente produjo **C12-r2** y **C12-CARACTERIZACION-20261107.md** en el checkout LOCAL basándose en `a446219`, con `STOP-DESIGN` por A1 (Unicode), A2 (BPM inválido), B (transición `bgPage`). Esos documentos **no aparecen aún publicados en la rama GitHub**, que contiene una versión remota antecedente. Cuidar los cambios de ambos lados.

## Primer paso obligatorio: proteger y reconciliar documentos

1. Inspeccionar `git status --short`, `git branch --show-current`, `git log -3 --oneline`, `git fetch origin`; leer instrucciones `AGENTS.md` aplicables.
2. **No** usar `git reset --hard`, `git clean`, checkout destructivo, `git pull` a ciegas ni `git merge` que borre las ediciones C12-r2 sin commit. Guardar primero los documentos locales en commit/worktree o copia versionada; preservar `Claude outputs/` y `beatgaler-console.jpg`.
3. Reconciliar el acta local C12-r2, su caracterización, los documentos remotos existentes y este anexo. Conservar los experimentos/fixtures/decisiones técnicos más completos de r2. No sustituirlos por un acta remota anterior abreviada.
4. Incorporar contrato Infinite Scroll en `C12-DECISION-RECORD.md`, `CONTRATO.md`, `TAREAS.md`, `ESTADO.md`, `EVIDENCIA.md` y `README.md` **solo después** de proteger los cambios de la IDE. Citar este anexo y el SHA real. Este paso sigue siendo SOLO DOCUMENTACIÓN.

## Segundo paso: diseñar implementación, no ejecutarla aún

Razonar el comportamiento actual y entregar un plan granular con arquitectura de virtualización por filas y contenedor de scroll existente, estimación de alturas y columnas responsive, overscan/caché bounded/prefetch, paginación interna con cursores firmados y keyset, scroll anchor al cargar/evict/resize, hover/artwork/montaje, React state de Playbar independiente de BeatCards, búsqueda global/ANY/exclusión, errores, accesibilidad, DnD/selección, retorno a detalle y legacy mode.

Mapear cambios en `AppShell`, `WebGalleryWorkspace`, `webLibraryWindow`, `webLibraryNavigation`, `librarySelectors`, `BeatCard`, `GalleryChrome`, CSS y stores de playback; no asumir que se pueden reusar directamente componentes paginados actuales. Incluir plan de pruebas y perf 100k/1M, scroll atrás, cambio de columnas y account switch. Identificar dónde la UI deja de tener un array global en memoria y qué hooks deben consumir solo la ventana.

Separar: **B-experiencia aprobado**, **B-legacy detalles pendientes**, **A1/A2 estatus según C12-r2**. No traducir «perfecto» a aceptación del límite 10.000 ni al copy de aviso. La opción de mostrar «Ir al inicio» ante un enlace antiguo no resoluble es recomendación técnica; registrar el impacto visible exacto.

## Estado y salida

El usuario autorizó **documentar y diseñar**; no se han abierto gates T01/T02, ni autorizado tocar runtime/producto, ni producción/AWS/Telegram/DB reales. Entregar un plan con tareas dependientes y STOP concretos; registrar SHA/paths y pruebas realmente ejecutadas. No declarar C12, T00 o G0 PASS por el anexo.
