# C12 — Evidencia de caracterización, 7 de noviembre de 2026

## Procedencia y límites

Checkout observado: `local/landing-gallery-unificada`, `a4462191aea29ffdae136f04e1fdc2e4024291d1`. El diff de `src/` y `cloud-server/` contra `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b` está vacío. No se cambió HEAD ni se hizo pull. No se encontraron AGENTS.md aplicables en el inventario del repositorio ni en los ancestros comprobados.

Se consultó mediante GitHub la misma rama remota en `9e0a7b237d8d063b6a50c4e71192d4b6716e0cd3`, cuatro commits por delante: documentación del probe/C12, workflow de probe y ajustes del runner documental; no diferencias de producto. Su acta C12 cita `894f4860522b41ad4c2531aca4a90ec96e04f529` como fuente. Esa acta es antecedente, no aprobación. No se incorporó el árbol remoto automáticamente.

El baseline Windows **histórico** de [T00-BASELINE-PASS-20261107.md](T00-BASELINE-PASS-20261107.md), sobre `5b199161351a05c62df79870d563cd7aceb5572f`, registra 68/68 pruebas, 25/25 mutaciones rechazadas y AST/TypeScript PASS. No se repitió aquí ni se atribuye ese resultado a pruebas futuras del catálogo.

Se verificaron estado, pasos y logs del [run 42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955), job `128536516538`, SHA `758669a4ca0df1f0b3f5cce6abef703e3ab10047`: success; PostgreSQL 16.15 (Debian), UTF8, `datcollate/datctype=en_US.utf8`, pg_trgm 1.6; rol/DB `catalog_g0_probe` / `beatgaler_catalog_g0_probe`, marcador del run y SHA verificado. Imagen `postgres:16@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109`; runner ubuntu-24.04, imagen 20261101.360.1. Los pasos de eliminación de contenedores/red terminaron correctamente. No reproducir credenciales de logs.

El [informe remoto del probe](https://github.com/magosouljah/BeatGaler/blob/9e0a7b237d8d063b6a50c4e71192d4b6716e0cd3/docs/plans/catalogo-postgresql/G0-POSTGRES-VERIFIED-20261107.md) concuerda con los logs. Esto resuelve **STOP-ENV del descriptor G0**; no verifica ICU, su versión, colación de nombres, catálogo, hardware de benchmark, performance, restauración ni T02. No se lanzó ningún workflow ni se conectó a una DB en este encargo.

## Índice de evidencia local

Las líneas corresponden al SHA local anterior. Todas son inspección estática salvo los experimentos indicados después.

| Ref. | Código inspeccionado | Hecho relevante |
| --- | --- | --- |
| E01 | `src/features/library/librarySelectors.ts:4–33` | `manual` preserva entrada; nombre usa localeCompare sin opciones; rating descendente y empate por índice manual; BPM resta Number. Filtro exacto ANY/ALL y exclusión NONE. q trim/lower; **BPM no se convierte a minúsculas**. |
| E02 | `src/app/useBeatGalerComposition.ts:103–129,625` | Único caller productivo del selector y del hook de vista; Web entrega ANY. `beats` ya materializados alimentan selector, tags y routing de sort. |
| E03 | `src/features/library/webLibrary.ts:13,129–193,238–316` | Página 240; filtra tombstones, preserva array, carga INDEX completo y routing antes de slice. Proyección name trim/fallback, BPM/key solo strings, rating clamp 0–255; no usar esta proyección para importar sin pérdida. |
| E04 | `src/features/library/webLibraryWindow.ts:30–73,81–124` | Offset arbitrario, prev=max(0,offset−240); si N>0 y offset fuera de rango, reabre última página alineada. Refresh conserva offset y coalesce. |
| E05 | `src/features/library/webLibraryNavigation.ts:1–42`; `WebLibraryPagination.tsx:11–32,64` | Evento `beatgaler:web-library-navigation`, estado offset/prev/next/pageSize/materializedCount/totalVisible; Number + isInteger sin safeInteger ni cota. Navega con location.assign; contador es total sin filtros. Clear no emite evento. |
| E06 | `src/features/library/useLibraryViewState.ts:12–20`; `libraryPresentationCache.ts:8–10,29–95,105–115`; `src/features/tags/useTagFilters.ts:13–53` | Search y tags en memoria; sort persistido globalmente, default rating. Cache de beats Web por propietario; no confundir preferencia global con datos privados. Toggle evita overlap, selector además prioriza exclusión. |
| E07 | `src/app/WebExperience.tsx:2–26`; `WebGalleryEntry.tsx:4–14`; `WebGalleryWorkspace.tsx:4–8`; `src/features/auth/AuthExperienceGate.tsx:125–219` | Landing lazy en `/`; cualquier bgPage en raíz redirige a Gallery preservando query/hash; login/signup/gallery tras auth. Workspace monta preconnect después de autenticación. Account generation y desmontaje protegen cambios de sesión. |
| E08 | `src/platform/webAdapter.ts:49,76–98,177` | Window→estado navegación y registry; lectura/refresh con guarda de cuenta; desconexión limpia recursos/window. Existe recuperación legacy de routing: no debe ser fallback POSTGRES. |
| E09 | `src/features/playback/webPlaybackRoutingCache.ts:5–6,81–91,282–335,399–440,557–576`; `useWebPlaybackSortRouting.ts:14–26` | Startup limitado a 14, pero routing/order actuales provienen del manifest completo. Su normalizador numérico difiere del DTO de Gallery. No copiar esa discrepancia al contrato SQL. |
| E10 | `src/features/playback/webStartupPlaybackCoordinator.ts:18–46,73–88,119–125`; `src/features/cloud/webGalerCloudTransport.ts:72–84` | Startup lee cache de cuenta/sort; barrier INDEX existe en coordinador. Catálogo debe desacoplar lectura metadata manteniendo transporte, streaming e intents. Los comentarios del coordinador no sustituyen el lugar real de montaje E07. |
| E11 | `src/lib/metadataValidation.ts:3–65`; `tests/unit/metadataValidation.test.ts` | Escrituras nuevas: tags normalizados hasta 30, 40 caracteres; BPM vacío o 60–300, hasta dos decimales. Import no puede cleanTags ni corregir legacy. |
| E12 | `cloud-server/library-beat-quota.js:6,21–44,87–123`; `library-index-publication.js:199`; `server-core.js:117–119` | Identidad duplicada rechazada; ACTIVE/TRASH y reservas contabilizados vía Access; TTL reserva 15 min. Publicador INDEX 16 MiB; parsers actuales 24mb publish/256kb general, **no** prueba de límite metadata 64 KiB. |
| E13 | `src/features/trash/webTrash.ts:118–122`; CONTRATO C9/C12 | 14 días en dato purge_after. Propuestas 35 días físicos y rollback 30 días no son prueba de retención ya instalada. |
| E14 | `src/features/tags/tagSelectors.ts:3–59`; `src/features/library/useLibraryReorder.ts:23–47`; `src/lib/tauri.ts:17,50–67,402–405` | Facetas/sugerencias se calculan con beats materializados, normalizan tags para mostrar pero filtro los compara exactos. Drag modifica array local; persistencia invoca Tauri y retorna sin invoke en Web. No prometer un reorder Web durable ya existente. |

Callers directos, inventariados con `rg` sobre todo `src`:

- `librarySelectors` y `useLibraryViewState`: `app/useBeatGalerComposition.ts`.
- `webLibrary`: `library/webLibraryWindow.ts`, `trash/webTrash.ts`, `edit/webBeatEdit.ts`, `import/webImportCommit.ts`. Import/edit/trash también llegan mediante `cloud/webGalerCloudTransport.ts` y `platform/webAdapter.ts`.
- `webLibraryNavigation`: `platform/webAdapter.ts`, `library/WebLibraryPagination.tsx`; Pagination lo monta `app/WebGalleryWorkspace.tsx`.
- `libraryPresentationCache`: `useLibraryViewState`, `useLibraryState`, `useLibraryReload`, `mergeActiveUploads`, `playback/webStartupPlaybackCoordinator`, `app/AppShell`, `design/GALLERY/GalleryChrome`. Los dos últimos usan limpieza de previews; no son un segundo backend.
- `LibraryUxBridge` monta en Workspace; decora DOM/accesibilidad, no consulta catálogo. Su rama `bg-product-gallery` evita redecorar el layout de Gallery.

Tests originales leídos, **no ejecutados en este encargo**: `tests/integration/libraryViewSelectors.test.ts`, `tests/component-dom/libraryViewState.test.tsx`, `webLibraryNavigation.test.ts`, `webLibraryWindow.test.ts`, `tests/unit/metadataValidation.test.ts`, `cloud-server/tests/library-beat-quota.test.cjs`. El título del test de navegación dice bounded, pero sus asserts no cubren la ausencia real de cota. No tomar el nombre del test como evidencia.

## Experimentos nuevos sin servicios

Se transpilaron únicamente selector y navegación con TypeScript instalado y se ejecutaron en VM, sin importar la aplicación ni cargar .env. Node **22.23.2**, ICU **78.2**, Unicode **17.0**; locale por defecto `es-MX`, sensitivity variant, numeric false, caseFirst false, ignorePunctuation false. El primer ensayo omitió target ES2022 y downleveló incorrectamente spreads de Set: sus resultados de tags se descartaron y repitieron con ES2022. No atribuir ese fallo del experimento al producto.

Chrome **152.0.7977.65**, headless con perfil temporal independiente, abrió solo HTML sintético local. UA HeadlessChrome/152.0.0.0, locale es-MX y mismas opciones Intl; el selector se transpila con ES2022. No abrió BeatGaler ni usó sesión/perfil del usuario. Artefacto temporal: `C:\Users\GTA7\AppData\Local\Temp\beatgaler-c12-synthetic-NFuWRT\probe.html`. No se midió Edge ni PostgreSQL; no afirmar paridad con ellos.

Entrada de nombres, IDs b0…b19 en este orden (NFD escapado):

```json
["z","ä","a","A","á","a\u0301","ñ","n","😀","🎵","a-2","a2","a10","a.2","I","İ","ı","i","same","same"]
```

| Ejecución | IDs de salida |
| --- | --- |
| Selector nombre, Node y Chrome, locale default es-MX | 9,8,2,3,4,5,1,10,13,12,11,17,14,15,16,7,6,18,19,0 |
| Intl explícito en/es, Node y Chrome, misma entrada | Igual a fila anterior en esta fixture únicamente |
| Intl explícito sv, Node y Chrome | 9,8,2,3,4,5,10,13,12,11,17,14,15,16,7,6,18,19,0,1 |
| Intl explícito tr, Node y Chrome | 9,8,2,3,4,5,1,10,13,12,11,16,14,17,15,7,6,18,19,0 |
| JS lower + comparación de bytes UTF8 en Node | 2,3,10,13,12,11,5,14,17,15,7,18,19,0,4,1,6,16,9,8 |
| Manual y rating con rating=0 para todos, Node | 0…19, empates conservados |

La comparación de bytes es una ilustración del candidato binario, **no una ejecución de lower() PostgreSQL**. Muestra pérdida de empate NFC/NFD y posición diferente de acentos/emoji. Universalidad queda refutada por sv/tr aunque Node y Chrome coincidan aquí. No se obtuvo una versión ICU del navegador de su UA.

BPM p0…p9 = `["200","oops","100",""," ","0x80","1e2","Infinity","-Infinity","NaN"]`: selector Node devolvió **p0,p1,p8,p3,p4,p2,p6,p5,p7,p9**. Solo `[p0,p1,p2]` devolvió **p0,p1,p2**. NaN en el comparador impide deducir un orden numérico total; no es legítimo inferir inválidos-al-final del código actual.

Fixture tags/búsqueda:

```json
[
 {"id":"red","name":"Árbol","tags":["Trap"],"key":"C#","bpm":"120","rating":0},
 {"id":"blue","name":"a\u0301rbol","tags":["trap","lofi"],"key":"Gm","bpm":"NaN","rating":0},
 {"id":"green","name":"İstanbul","tags":["lofi"],"key":"","bpm":"100","rating":0}
]
```

Resultados Node ES2022: ANY `[Trap,lofi]` → red,blue,green; ALL → ninguno; ANY y excluir Trap → blue,green; incluir trap → blue. q `á`→red, `arbol`→ninguno, `nan`→ninguno, `120`→red, `%`→ninguno. Minúsculas JS: `İ→i\u0307`, `I→i`, `ı→ı`, `Σ→σ`, `ΟΣ→ος`, `ẞ→ß`; `ß` no pasa a ss. No hay normalización NFC ni eliminación de acentos.

Offsets Node: ausente→0; 240→240; −1/1.5/oops→0; 1e9→1000000000; 0xF0→240; 9007199254740993→9007199254740992 por redondeo; duplicado 240&480→240. URL a 480 preservó `?x=1` y `#player`. El retorno al final fuera de rango procede de lectura estática E04, no de este experimento puro.

Reproducción mínima desde raíz, sin servicios (no es runner T01 ni prueba SQL):

```javascript
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const sandbox = { exports: {}, URL, URLSearchParams };
vm.runInNewContext(ts.transpileModule(
  fs.readFileSync('src/features/library/librarySelectors.ts', 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText, sandbox);
const select = sandbox.exports.selectFilteredAndSortedBeats;
// Pegar la fixture anterior como rows. No cargar módulos de auth/Cloud.
const ids = (rows, q, inc, exc, mode) => select(
  rows, q, new Set(inc), new Set(exc), 'manual', mode
).map(b => b.id);
// ids(rows, '', ['Trap','lofi'], [], 'any') => ['red','blue','green']
```

Estos experimentos caracterizan ejemplos; no certifican el esquema, API, aplicación integrada, rendimiento, backups ni compatibilidad exhaustiva Unicode. La matriz futura y los bloqueos están en [C12-DECISION-RECORD.md](C12-DECISION-RECORD.md).
