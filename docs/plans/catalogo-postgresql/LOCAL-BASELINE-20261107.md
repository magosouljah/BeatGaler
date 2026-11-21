# BeatGaler — Actualización del plan PostgreSQL para LOCAL

**Fecha:** 7 de noviembre de 2026  
**Alcance:** documentación y revisión de precondiciones G0. **No autoriza implementación, migraciones, despliegue ni escrituras en PostgreSQL/Telegram/AWS.**  
**Prioridad:** esta actualización prevalece sobre cualquier referencia a ramas antiguas o a un frontend anterior en los seis documentos del plan LOCAL. El plan técnico de datos existente mantiene su autoridad en todo lo no modificado aquí.

## 1. Base de código y evidencia verificada

- **Base LOCAL de integración confirmada en GitHub:** commit `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`, recuperable mediante tag `archive/20261107/codex/landing-gallery-integration-20261105`. El checkout físico LOCAL debe identificar su propio `HEAD`, rama y modificaciones no confirmadas: el tag no demuestra que `E:\777\app\BeatGaler` esté exactamente en ese estado.
- **Base de la auditoría PostgreSQL anterior:** `7f2dc5823a4d2cd87333ee3b6833ae46e9029b3b` (histórico de `main`, NO la versión LOCAL para trabajar).
- **Comparación verificada:** 7 commits adicionales y 59 archivos cambiados entre el corte de la auditoría y la integración LOCAL. Cambios en UI, rutas, pruebas y flujo Web; **el árbol `cloud-server/` es idéntico** (`bcb488ae3802dfd2bbe8f3fe6245b314a152c189`). También se mantienen idénticos `src-tauri/`, `package.json` y `package-lock.json`. Por tanto la arquitectura del catálogo no necesita reiniciarse; sí debe adaptarse la interfaz Web y la aceptación.
- **`main` actual no es la base de implementación LOCAL:** se recuperó allí `DESIGN/`, pero la integración Web de Landing/Gallery aún no está en `src/` de `main`. No copiar `src/` desde `main`, no hacer merges de ramas históricas ni resets que reviertan la UI.
- **Sin afirmar pruebas no realizadas:** el PR histórico #151 registró *Web Production Build: PASS*, pero *Direct - Persistent Vault Assignment: FAIL*; requiere determinar si eran tests acoplados al antiguo bootstrap o problemas de código. La integración LOCAL sigue necesitando aceptación real de sesión y playback en entorno seguro. Evidencia: `https://github.com/magosouljah/BeatGaler/pull/151`, `https://github.com/magosouljah/BeatGaler/actions/runs/42353075806`.

### Verificación local obligatoria antes de cambiar los seis documentos

Ejecutar exclusivamente lecturas Git (`git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git merge-base --is-ancestor 31861e6 HEAD`) y confirmar que los archivos siguientes existen y son los de LOCAL. No cambiar de rama ni ejecutar `npm run dev` para actualizar el plan.

## 2. Contratos actuales de LOCAL que el catálogo debe preservar

| Área | Implementación LOCAL auditada | Adaptación exigida al catálogo PG |
| --- | --- | --- |
| Entrada pública | `src/app/WebExperience.tsx`; `/` muestra Landing pública diferida | Landing no debe cargar biblioteca, no necesita DB de catálogo y no debe bloquearse por caída de Telegram/PG mientras solo muestra contenido público. |
| Sesión | `src/app/WebGalleryEntry.tsx` y `src/features/auth/AuthExperienceGate.tsx`; `/gallery`, `/login`, `/signup` | Catalog API requiere identidad autorizada; no consultar ni filtrar por user ID declarado por el cliente. Preserve redirect al `/gallery` tras autenticación. |
| Arranque Direct | `src/app/WebGalleryWorkspace.tsx` llama `preconnectRememberedWebDirect()` tras montar el workspace autenticado | **No reponer automáticamente** la antigua preconexión global en `src/main.tsx`. Auditar semántica y pruebas del bootstrap: `issue97RuntimeWebFollowup.test.ts` todavía exige el punto antiguo. El catálogo PG puede listarse sin conexión Telegram; la reproducción/salida de media conecta a demanda. |
| Composición real | `src/app/AppShell.tsx`, `src/app/useBeatGalerComposition.ts`, `src/components/Player.tsx`, `src/components/BeatCard.tsx` | Conservar Playbar, handlers reales, drag/drop, selección, importación y edición. Integrar los DTO/queries de catálogo detrás del bridge y sus hooks; no reconstruir AppShell con la versión antigua de `main`. |
| Barra de tags | `src/features/design/GALLERY/GalleryChrome.tsx`, `TagNavigation.tsx` | Etiquetas disponibles, inclusión/exclusión, colores, rename y contadores deben surgir del backend PG sin cargar INDEX entero. Mantener estados/hover/layout y sin flicker en paginación. |
| Filtros y orden | `src/features/library/librarySelectors.ts` usa `includeMode: "any"` opcional; la variante Web usa inclusión ANY y exclusión prioritaria; manual/name/BPM/rating | Especificar semántica inequívoca en API: ANY entre incluidos, NONE entre excluidos y búsqueda sin distinguir mayúsculas; en Web las consultas deben conservar UX y sort estable con desempate por ID. No transformar a ALL silenciosamente. |
| Paginación | `src/features/library/WebLibraryPagination.tsx` y `webLibraryNavigation.ts`; `bgPage`/offset en URL | Diseñar cursor opaco y consistente del catálogo sin romper bookmarks de `/?bgPage=…` o `/gallery?bgPage=…`. Establecer fase de compatibilidad de URL, no esconder una relectura completa del INDEX tras una página. |
| BeatCard | `src/components/BeatCard.tsx` y `src/features/design/shared/beatCardTags.ts`, artwork y stars | DTO debe incluir tags, BPM/key originales, rating completo, versión de beat, cover/media refs sin exponer locators privados; mantener altura fija y compactación. No reducir rating a 0–5 en la autoridad. |
| Player | `src/components/Player.tsx`, cachés de playback, cola y seek | Solo resolver las rutas de los assets requeridos; invalidar por `owner_id`, `beat_version`, `asset_version` y sesión. Transición de página no debe cortar audio o corromper cola. |
| Cuentas | `LibraryUxBridge`, estados de sesión, cachés y cambio de cuenta | Cancelar solicitudes anteriores / limpiar cachés de otra cuenta al cambiar identidad. Evitar mezclas de bibliotecas entre tabs, generaciones o requests. |
| Worker/transport | `webGalerCloudTransport.ts`, `webTransport.worker.ts`, Cloud | Mantener data plane Telegram para bytes y proyectos; para bibliotecas PG cercar `get/replace/publish/commit INDEX` incluso por caminos heredados. |

**No inferir contrato SQL solo de clases CSS o fixtures.** Verificar que estos símbolos están conectados al runtime LOCAL actual antes de implementar interfaces. Los archivos de `DESIGN/` solo son referencia óptica y de UX, no fuente de autoridad del catálogo.

## 3. Cambios requeridos en los seis documentos canónicos

### `README.md`

Indicar que el plan se aplica a `local/landing-gallery-unificada` (o la rama REAL comprobada por Git), no a `main`. Enlazar este anexo e indicar que la actualización no cambia el número de tareas original. Separar *entorno* (LOCAL) de *rama* (Git). G0 no se marca aprobado por el mero hecho de recuperar el diseño.

### `EVIDENCIA.md`

Agregar matriz BASE AUDITADA (`7f2dc582`) → FRONTEND LOCAL (`31861e6`) → HEAD del checkout físico. Documentar 59 archivos, siete commits, invarianza byte a byte del árbol Cloud y de `package*.json`, rutas y símbolos nuevos. Clasificar como **evidencia estática GitHub**, no prueba del checkout local no inspeccionado. Registrar resultados de CI existentes y deuda de Direct sin asumir su causa. Verificar `git diff 31861e6..HEAD` y `git status` antes de declarar paridad real.

### `CONTRATO.md`

Añadir el contrato de UI/API anterior: rutas públicas/privadas, autenticación, preconexión solo autenticada, snapshot/paginación, semántica ANY Web, filtros excluidos, búsqueda/sort, identidad y versión, media a demanda, estado de papelera y manejo de cuenta/cache. El nuevo `GET /catalog/v1/...` no debe exigir Telegram ni INDEX. No fijar endpoints concretos sin validar la nomenclatura ya aprobada en el contrato local.

### `TAREAS.md`

Mantener **las 26 tareas y sus identificadores originales**, NO reescribir su orden ni dar por ejecutada ninguna. Incorporar dependencias transversales y aceptación en las tareas pertinentes: (a) montar API/DTO a partir de `WebGalleryWorkspace` y bridge actual, (b) migrar filtros y paginación real, (c) desconectar Worker de INDEX para usuarios PG sin romper playback, (d) pruebas de sesiones y compatibilidad con nueva Gallery. Si una tarea no cubre un riesgo, señalarlo como subcriterio, no crear otra tarea numerada antes de auditar el plan.

### `MIGRACION.md`

Mantener los gates **G0–G4**. Primero postgres descartable y Telegram falso; no reutilizar credenciales/DB de producción; impedir migraciones automáticas desde `server.js` durante arranque del LOCAL. Fuentes legacy pueden exportarse en una fase posterior autorizada, sin modificar el Telegram real. El corte por biblioteca, export/restore completo y rollback de software compatible permanecen requisitos. Añadir un *smoke* de Landing anónima y Gallery autenticada después de cada gate.

### `ESTADO.md`

Registrar `baseline_code = HEAD físico` una vez comprobado, `baseline_reference = 31861e6`, `cloud_tree = bcb488a...`, `G0 = PENDIENTE DE VALIDACIÓN`, `implementación = NO INICIADA/NO CONFIRMADA` según evidencia REAL local. Dejar pendientes exactos: pruebas Direct, DB test aislada (issue #133), mapeo de tags/orden/paginación, rutas legacy de INDEX, CI del frontend, smoke y contratos PROJECT/purge. El documento solo puede marcar G0 PASS tras ejecutar pruebas efectivas y registrar resultados.

## 4. G0 — aceptación antes de T01

1. Identificar `git rev-parse HEAD` y rama de LOCAL; documentar diff y uncommitted changes. Verificar que `31861e6` es ancestro y que el código integrado no fue sustituido.
2. Leer y contrastar los **seis documentos** existentes; registrar las 26 tareas actuales sin renumerarlas, los gates G0–G4, sus evidencias y cambios propuestos. Si se detecta contenido diferente a lo supuesto aquí, mantenerlo y anotar discrepancia.
3. Confirmar que `cloud-server/` es el que corresponde a la base; si el checkout tiene cambios posteriores, inspeccionarlos antes de continuar. La igualdad con `7f2dc582` solo se demostró para el snapshot GitHub `31861e6`.
4. En G0/T00 identificar y aprobar un descriptor de instancia PostgreSQL **descartable y separada**, versión y política de aislamiento, sin conectar, crear o destruir bases durante esta auditoría documental. T02 creará DBs efímeras con guardas verificadas, después de T01. No ejecutar agregadores ni `postgres-live.integration.cjs` con secretos o URLs heredados.
5. Ejecutar baseline reproducible de rutas, Auth, LibraryUxBridge, paginación, Gallery, Playbar, import/edit/trash, Direct, INDEX y tests Cloud pertinentes. Clasificar cada fallo como heredado, nuevo o indeterminado; prohibir merges o revertir archivos solo para hacer pasar tests viejos.
6. Definir DTO/catalog contract y matriz de equivalencia de **todos** los campos del INDEX incluyendo partes, PROJECT, trash, tombstones, unknowns, ratings 0–255, tags y orden.
7. Aprobar límites de seguridad: ningún cambio de producción, EC2/RDS, Telegram MASTER real, Vaults o datos reales. No migrar bibliotecas sin snapshot, comparador, fences, backups y procedimiento de rollback probado.

**G0 = NO APROBADO por esta actualización documental.** Esta es una corrección de base y criterios, no implementación.

## 5. Criterios de prueba LOCAL añadidos

- Landing (`/`) accesible sin sesión y sin tocar PostgreSQL/Telegram; CTA conserva navegación.
- `/signup`, `/login`, `/gallery`: sesión/OTP/restauración/logout/cambio de cuenta, redirects y cachés.
- Gallery con biblioteca vacía, pequeña y grande; paginación sin INDEX completo; filtro ANY + exclusiones, búsqueda, orden y `bgPage` anterior.
- BeatCard no cambia de tamaño; rating, tags/colores, BPM/key, portada, menú y estado de reproducción no regresan.
- Player real: play/pause, siguiente/anterior, seek, cola, cambios entre páginas, precarga Direct y rutas de media por versión; ninguna llamada Telegram para PATCH de metadatos.
- Importación y edición incrementales: ID3/metadata, reemplazo de slots, PROJECT multipart, upload interrumpido, idempotencia, cuotas y manejo de ack desconocido.
- Trash/restore/purge y tombstones en SQL; no eliminar objetos compartidos ni permitir escritura legacy de INDEX para POSTGRES.
- Dos clientes/usuarios sintéticos y cambios de cuenta: ninguna fuga de datos, escrituras cruzadas ni cachés obsoletas.
- Con base y proveedor falsos: PostgreSQL caído, Telegram caído, MASTER caído, restart del worker y carreras de CAS; SQL no espera red externa bajo transacción.
- Preservar reglas visuales y tests de diseño, sin exigir que DESIGN se conecte al catálogo ni sacrificar rendimiento por tooltips.

## 6. Estado y próximos pasos

**Confirmado por revisión remota:** integraciones UI LOCAL añadidas; núcleo Cloud sin cambios entre `7f2dc582` y `31861e6`; trabajo INDEX → PG sigue siendo necesario.  
**No comprobado en el PC LOCAL desde esta conversación:** SHA actual del checkout, archivos `README/EVIDENCIA/CONTRATO/TAREAS/MIGRACION/ESTADO` y ejecución de sus pruebas.  
**Por ejecutar:** aplicar este anexo sin sobrescribir los seis documentos; validar G0; solo entonces iniciar T01 y sus migraciones en una DB descartable.

### Referencias fijadas

- [Snapshot LOCAL de la integración](https://github.com/magosouljah/BeatGaler/tree/31861e6406ac10073d368aa5d8a4edcb5dfd2d2b)
- [Plan de integración visual ya implementada en LOCAL](https://github.com/magosouljah/BeatGaler/blob/31861e6406ac10073d368aa5d8a4edcb5dfd2d2b/docs/LANDING-GALLERY-INTEGRATION.md)
- [Versión archivada de LOCAL](https://github.com/magosouljah/BeatGaler/tree/archive/20261107/codex/landing-gallery-integration-20261105)
- [Seguimiento de revisión pendiente del frontend](https://github.com/magosouljah/BeatGaler/issues/152)
- [Issue #133 — DB test aislada](https://github.com/magosouljah/BeatGaler/issues/133)


## 7. Addendum de verificación remota G0

El 7 de noviembre de 2026 el usuario mostró `local/landing-gallery-unificada`, HEAD `edabd71`, y diferencias limitadas a siete documentos. GitHub confirmó el commit completo `edabd715664f9564346e95b8553b68b4ac411da9` y ningún cambio de aplicación desde `31861e6`. Los archivos locales sin seguimiento `Claude outputs/` y `beatgaler-console.jpg` quedaron ajenos al commit. **No se reejecutaron pruebas**; G0 sigue NO APROBADO. Las comprobaciones de T00 y la aprobación de decisiones C12 están pendientes. Ver [G0-AUDITORIA-20261107.md](G0-AUDITORIA-20261107.md).
