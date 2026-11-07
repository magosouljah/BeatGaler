# BeatGaler â€” ActualizaciÃ³n del plan PostgreSQL para LOCAL

**Fecha:** 7 de noviembre de 2026  
**Alcance:** documentaciÃ³n y revisiÃ³n de precondiciones G0. **No autoriza implementaciÃ³n, migraciones, despliegue ni escrituras en PostgreSQL/Telegram/AWS.**  
**Prioridad:** esta actualizaciÃ³n prevalece sobre cualquier referencia a ramas antiguas o a un frontend anterior en los seis documentos del plan LOCAL. El plan tÃ©cnico de datos existente mantiene su autoridad en todo lo no modificado aquÃ­.

## 1. Base de cÃ³digo y evidencia verificada

- **Base LOCAL de integraciÃ³n confirmada en GitHub:** commit `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`, recuperable mediante tag `archive/20261107/codex/landing-gallery-integration-20261105`. El checkout fÃ­sico LOCAL debe identificar su propio `HEAD`, rama y modificaciones no confirmadas: el tag no demuestra que `E:\777\app\BeatGaler` estÃ© exactamente en ese estado.
- **Base de la auditorÃ­a PostgreSQL anterior:** `7f2dc5823a4d2cd87333ee3b6833ae46e9029b3b` (histÃ³rico de `main`, NO la versiÃ³n LOCAL para trabajar).
- **ComparaciÃ³n verificada:** 7 commits adicionales y 59 archivos cambiados entre el corte de la auditorÃ­a y la integraciÃ³n LOCAL. Cambios en UI, rutas, pruebas y flujo Web; **el Ã¡rbol `cloud-server/` es idÃ©ntico** (`bcb488ae3802dfd2bbe8f3fe6245b314a152c189`). TambiÃ©n se mantienen idÃ©nticos `src-tauri/`, `package.json` y `package-lock.json`. Por tanto la arquitectura del catÃ¡logo no necesita reiniciarse; sÃ­ debe adaptarse la interfaz Web y la aceptaciÃ³n.
- **`main` actual no es la base de implementaciÃ³n LOCAL:** se recuperÃ³ allÃ­ `DESIGN/`, pero la integraciÃ³n Web de Landing/Gallery aÃºn no estÃ¡ en `src/` de `main`. No copiar `src/` desde `main`, no hacer merges de ramas histÃ³ricas ni resets que reviertan la UI.
- **Sin afirmar pruebas no realizadas:** el PR histÃ³rico #151 registrÃ³ *Web Production Build: PASS*, pero *Direct - Persistent Vault Assignment: FAIL*; requiere determinar si eran tests acoplados al antiguo bootstrap o problemas de cÃ³digo. La integraciÃ³n LOCAL sigue necesitando aceptaciÃ³n real de sesiÃ³n y playback en entorno seguro. Evidencia: `https://github.com/magosouljah/BeatGaler/pull/151`, `https://github.com/magosouljah/BeatGaler/actions/runs/42353075806`.

### VerificaciÃ³n local obligatoria antes de cambiar los seis documentos

Ejecutar exclusivamente lecturas Git (`git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git merge-base --is-ancestor 31861e6 HEAD`) y confirmar que los archivos siguientes existen y son los de LOCAL. No cambiar de rama ni ejecutar `npm run dev` para actualizar el plan.

## 2. Contratos actuales de LOCAL que el catÃ¡logo debe preservar

| Ãrea | ImplementaciÃ³n LOCAL auditada | AdaptaciÃ³n exigida al catÃ¡logo PG |
| --- | --- | --- |
| Entrada pÃºblica | `src/app/WebExperience.tsx`; `/` muestra Landing pÃºblica diferida | Landing no debe cargar biblioteca, no necesita DB de catÃ¡logo y no debe bloquearse por caÃ­da de Telegram/PG mientras solo muestra contenido pÃºblico. |
| SesiÃ³n | `src/app/WebGalleryEntry.tsx` y `src/features/auth/AuthExperienceGate.tsx`; `/gallery`, `/login`, `/signup` | Catalog API requiere identidad autorizada; no consultar ni filtrar por user ID declarado por el cliente. Preserve redirect al `/gallery` tras autenticaciÃ³n. |
| Arranque Direct | `src/app/WebGalleryWorkspace.tsx` llama `preconnectRememberedWebDirect()` tras montar el workspace autenticado | **No reponer automÃ¡ticamente** la antigua preconexiÃ³n global en `src/main.tsx`. Auditar semÃ¡ntica y pruebas del bootstrap: `issue97RuntimeWebFollowup.test.ts` todavÃ­a exige el punto antiguo. El catÃ¡logo PG puede listarse sin conexiÃ³n Telegram; la reproducciÃ³n/salida de media conecta a demanda. |
| ComposiciÃ³n real | `src/app/AppShell.tsx`, `src/app/useBeatGalerComposition.ts`, `src/components/Player.tsx`, `src/components/BeatCard.tsx` | Conservar Playbar, handlers reales, drag/drop, selecciÃ³n, importaciÃ³n y ediciÃ³n. Integrar los DTO/queries de catÃ¡logo detrÃ¡s del bridge y sus hooks; no reconstruir AppShell con la versiÃ³n antigua de `main`. |
| Barra de tags | `src/features/design/GALLERY/GalleryChrome.tsx`, `TagNavigation.tsx` | Etiquetas disponibles, inclusiÃ³n/exclusiÃ³n, colores, rename y contadores deben surgir del backend PG sin cargar INDEX entero. Mantener estados/hover/layout y sin flicker en paginaciÃ³n. |
| Filtros y orden | `src/features/library/librarySelectors.ts` usa `includeMode: "any"` opcional; la variante Web usa inclusiÃ³n ANY y exclusiÃ³n prioritaria; manual/name/BPM/rating | Especificar semÃ¡ntica inequÃ­voca en API: ANY entre incluidos, NONE entre excluidos y bÃºsqueda sin distinguir mayÃºsculas; en Web las consultas deben conservar UX y sort estable con desempate por ID. No transformar a ALL silenciosamente. |
| PaginaciÃ³n | `src/features/library/WebLibraryPagination.tsx` y `webLibraryNavigation.ts`; `bgPage`/offset en URL | DiseÃ±ar cursor opaco y consistente del catÃ¡logo sin romper bookmarks de `/?bgPage=â€¦` o `/gallery?bgPage=â€¦`. Establecer fase de compatibilidad de URL, no esconder una relectura completa del INDEX tras una pÃ¡gina. |
| BeatCard | `src/components/BeatCard.tsx` y `src/features/design/shared/beatCardTags.ts`, artwork y stars | DTO debe incluir tags, BPM/key originales, rating completo, versiÃ³n de beat, cover/media refs sin exponer locators privados; mantener altura fija y compactaciÃ³n. No reducir rating a 0â€“5 en la autoridad. |
| Player | `src/components/Player.tsx`, cachÃ©s de playback, cola y seek | Solo resolver las rutas de los assets requeridos; invalidar por `owner_id`, `beat_version`, `asset_version` y sesiÃ³n. TransiciÃ³n de pÃ¡gina no debe cortar audio o corromper cola. |
| Cuentas | `LibraryUxBridge`, estados de sesiÃ³n, cachÃ©s y cambio de cuenta | Cancelar solicitudes anteriores / limpiar cachÃ©s de otra cuenta al cambiar identidad. Evitar mezclas de bibliotecas entre tabs, generaciones o requests. |
| Worker/transport | `webGalerCloudTransport.ts`, `webTransport.worker.ts`, Cloud | Mantener data plane Telegram para bytes y proyectos; para bibliotecas PG cercar `get/replace/publish/commit INDEX` incluso por caminos heredados. |

**No inferir contrato SQL solo de clases CSS o fixtures.** Verificar que estos sÃ­mbolos estÃ¡n conectados al runtime LOCAL actual antes de implementar interfaces. Los archivos de `DESIGN/` solo son referencia Ã³ptica y de UX, no fuente de autoridad del catÃ¡logo.

## 3. Cambios requeridos en los seis documentos canÃ³nicos

### `README.md`

Indicar que el plan se aplica a `local/landing-gallery-unificada` (o la rama REAL comprobada por Git), no a `main`. Enlazar este anexo e indicar que la actualizaciÃ³n no cambia el nÃºmero de tareas original. Separar *entorno* (LOCAL) de *rama* (Git). G0 no se marca aprobado por el mero hecho de recuperar el diseÃ±o.

### `EVIDENCIA.md`

Agregar matriz BASE AUDITADA (`7f2dc582`) â†’ FRONTEND LOCAL (`31861e6`) â†’ HEAD del checkout fÃ­sico. Documentar 59 archivos, siete commits, invarianza byte a byte del Ã¡rbol Cloud y de `package*.json`, rutas y sÃ­mbolos nuevos. Clasificar como **evidencia estÃ¡tica GitHub**, no prueba del checkout local no inspeccionado. Registrar resultados de CI existentes y deuda de Direct sin asumir su causa. Verificar `git diff 31861e6..HEAD` y `git status` antes de declarar paridad real.

### `CONTRATO.md`

AÃ±adir el contrato de UI/API anterior: rutas pÃºblicas/privadas, autenticaciÃ³n, preconexiÃ³n solo autenticada, snapshot/paginaciÃ³n, semÃ¡ntica ANY Web, filtros excluidos, bÃºsqueda/sort, identidad y versiÃ³n, media a demanda, estado de papelera y manejo de cuenta/cache. El nuevo `GET /catalog/v1/...` no debe exigir Telegram ni INDEX. No fijar endpoints concretos sin validar la nomenclatura ya aprobada en el contrato local.

### `TAREAS.md`

Mantener **las 26 tareas y sus identificadores originales**, NO reescribir su orden ni dar por ejecutada ninguna. Incorporar dependencias transversales y aceptaciÃ³n en las tareas pertinentes: (a) montar API/DTO a partir de `WebGalleryWorkspace` y bridge actual, (b) migrar filtros y paginaciÃ³n real, (c) desconectar Worker de INDEX para usuarios PG sin romper playback, (d) pruebas de sesiones y compatibilidad con nueva Gallery. Si una tarea no cubre un riesgo, seÃ±alarlo como subcriterio, no crear otra tarea numerada antes de auditar el plan.

### `MIGRACION.md`

Mantener los gates **G0â€“G4**. Primero postgres descartable y Telegram falso; no reutilizar credenciales/DB de producciÃ³n; impedir migraciones automÃ¡ticas desde `server.js` durante arranque del LOCAL. Fuentes legacy pueden exportarse en una fase posterior autorizada, sin modificar el Telegram real. El corte por biblioteca, export/restore completo y rollback de software compatible permanecen requisitos. AÃ±adir un *smoke* de Landing anÃ³nima y Gallery autenticada despuÃ©s de cada gate.

### `ESTADO.md`

Registrar `baseline_code = HEAD fÃ­sico` una vez comprobado, `baseline_reference = 31861e6`, `cloud_tree = bcb488a...`, `G0 = PENDIENTE DE VALIDACIÃ“N`, `implementaciÃ³n = NO INICIADA/NO CONFIRMADA` segÃºn evidencia REAL local. Dejar pendientes exactos: pruebas Direct, DB test aislada (issue #133), mapeo de tags/orden/paginaciÃ³n, rutas legacy de INDEX, CI del frontend, smoke y contratos PROJECT/purge. El documento solo puede marcar G0 PASS tras ejecutar pruebas efectivas y registrar resultados.

## 4. G0 â€” aceptaciÃ³n antes de T01

1. Identificar `git rev-parse HEAD` y rama de LOCAL; documentar diff y uncommitted changes. Verificar que `31861e6` es ancestro y que el cÃ³digo integrado no fue sustituido.
2. Leer y contrastar los **seis documentos** existentes; registrar las 26 tareas actuales sin renumerarlas, los gates G0â€“G4, sus evidencias y cambios propuestos. Si se detecta contenido diferente a lo supuesto aquÃ­, mantenerlo y anotar discrepancia.
3. Confirmar que `cloud-server/` es el que corresponde a la base; si el checkout tiene cambios posteriores, inspeccionarlos antes de continuar. La igualdad con `7f2dc582` solo se demostrÃ³ para el snapshot GitHub `31861e6`.
4. Establecer una base PostgreSQL **descartable y separada**, sin variables de entorno productivas, con guardas de destino en todas las pruebas que crean/drop schemas. No ejecutar agregadores ni `postgres-live.integration.cjs` con secretos o URLs heredados.
5. Ejecutar baseline reproducible de rutas, Auth, LibraryUxBridge, paginaciÃ³n, Gallery, Playbar, import/edit/trash, Direct, INDEX y tests Cloud pertinentes. Clasificar cada fallo como heredado, nuevo o indeterminado; prohibir merges o revertir archivos solo para hacer pasar tests viejos.
6. Definir DTO/catalog contract y matriz de equivalencia de **todos** los campos del INDEX incluyendo partes, PROJECT, trash, tombstones, unknowns, ratings 0â€“255, tags y orden.
7. Aprobar lÃ­mites de seguridad: ningÃºn cambio de producciÃ³n, EC2/RDS, Telegram MASTER real, Vaults o datos reales. No migrar bibliotecas sin snapshot, comparador, fences, backups y procedimiento de rollback probado.

**G0 = NO APROBADO por esta actualizaciÃ³n documental.** Esta es una correcciÃ³n de base y criterios, no implementaciÃ³n.

## 5. Criterios de prueba LOCAL aÃ±adidos

- Landing (`/`) accesible sin sesiÃ³n y sin tocar PostgreSQL/Telegram; CTA conserva navegaciÃ³n.
- `/signup`, `/login`, `/gallery`: sesiÃ³n/OTP/restauraciÃ³n/logout/cambio de cuenta, redirects y cachÃ©s.
- Gallery con biblioteca vacÃ­a, pequeÃ±a y grande; paginaciÃ³n sin INDEX completo; filtro ANY + exclusiones, bÃºsqueda, orden y `bgPage` anterior.
- BeatCard no cambia de tamaÃ±o; rating, tags/colores, BPM/key, portada, menÃº y estado de reproducciÃ³n no regresan.
- Player real: play/pause, siguiente/anterior, seek, cola, cambios entre pÃ¡ginas, precarga Direct y rutas de media por versiÃ³n; ninguna llamada Telegram para PATCH de metadatos.
- ImportaciÃ³n y ediciÃ³n incrementales: ID3/metadata, reemplazo de slots, PROJECT multipart, upload interrumpido, idempotencia, cuotas y manejo de ack desconocido.
- Trash/restore/purge y tombstones en SQL; no eliminar objetos compartidos ni permitir escritura legacy de INDEX para PG_ACTIVE.
- Dos clientes/usuarios sintÃ©ticos y cambios de cuenta: ninguna fuga de datos, escrituras cruzadas ni cachÃ©s obsoletas.
- Con base y proveedor falsos: PostgreSQL caÃ­do, Telegram caÃ­do, MASTER caÃ­do, restart del worker y carreras de CAS; SQL no espera red externa bajo transacciÃ³n.
- Preservar reglas visuales y tests de diseÃ±o, sin exigir que DESIGN se conecte al catÃ¡logo ni sacrificar rendimiento por tooltips.

## 6. Estado y prÃ³ximos pasos

**Confirmado por revisiÃ³n remota:** integraciones UI LOCAL aÃ±adidas; nÃºcleo Cloud sin cambios entre `7f2dc582` y `31861e6`; trabajo INDEX â†’ PG sigue siendo necesario.  
**No comprobado en el PC LOCAL desde esta conversaciÃ³n:** SHA actual del checkout, archivos `README/EVIDENCIA/CONTRATO/TAREAS/MIGRACION/ESTADO` y ejecuciÃ³n de sus pruebas.  
**Por ejecutar:** aplicar este anexo sin sobrescribir los seis documentos; validar G0; solo entonces iniciar T01 y sus migraciones en una DB descartable.

### Referencias fijadas

- [Snapshot LOCAL de la integraciÃ³n](https://github.com/magosouljah/BeatGaler/tree/31861e6406ac10073d368aa5d8a4edcb5dfd2d2b)
- [Plan de integraciÃ³n visual ya implementada en LOCAL](https://github.com/magosouljah/BeatGaler/blob/31861e6406ac10073d368aa5d8a4edcb5dfd2d2b/docs/LANDING-GALLERY-INTEGRATION.md)
- [VersiÃ³n archivada de LOCAL](https://github.com/magosouljah/BeatGaler/tree/archive/20261107/codex/landing-gallery-integration-20261105)
- [Seguimiento de revisiÃ³n pendiente del frontend](https://github.com/magosouljah/BeatGaler/issues/152)
- [Issue #133 â€” DB test aislada](https://github.com/magosouljah/BeatGaler/issues/133)
