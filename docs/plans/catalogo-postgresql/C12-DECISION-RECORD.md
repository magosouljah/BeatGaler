# C12 — Registro técnico para cierre por IDE inteligente

**Fuente:** rama `local/landing-gallery-unificada`, SHA `894f4860522b41ad4c2531aca4a90ec96e04f529`, 7 de noviembre de 2026.
**Dictamen:** REVISIÓN PARCIAL. **STOP-DESIGN** hasta completar paridad Unicode y compatibilidad `bgPage`. T00 y G0 globales NO PASS; T01 NO iniciado. No se alteró el producto.

## Evidencia del código LOCAL

| Ruta y línea | Contrato real observado |
| --- | --- |
| `src/app/useBeatGalerComposition.ts:103–118` | Gallery Web llama selector con `includeMode="any"`; Desktop con `"all"` |
| `src/features/library/librarySelectors.ts:15–33` | q = `trim().toLowerCase()`, substring en nombre/tags/key/`String(bpm)`; tags de filtro exactos `beat.tags.includes(tag)`; exclusión de cualquiera; `manual` deja orden de entrada; BPM `Number(bpm||0)`; rating descendente, empate ordinal; nombre `localeCompare` sin locale explícito |
| `src/features/library/webLibrary.ts:13,238–316` | La primera página materializa **240** beats; el INDEX entero se normaliza para routing y luego se corta por offset; hoy se filtra/ordena la página materializada, no globalmente |
| `src/features/library/webLibraryNavigation.ts:1–26` | `bgPage` es offset entero no negativo, no número de página ni cursor; al crear URL con offset 0 se elimina el parámetro |
| `src/features/library/WebLibraryPagination.tsx:24–32` | Prev/Next navegan por offset con `window.location.assign`, preservando el rango mostrado |
| `src/app/WebGalleryEntry.tsx:4–14` | Workspace se carga dentro de `AuthExperienceGate`; conservar autenticación antes de Direct |
| `docs/plans/catalogo-postgresql/CONTRATO.md` C5/C11/C12 | API, seguridad, límites, rendimiento, retención, rollback y la propuesta de sort SQL que todavía no está aceptada |

## Decisiones técnicas de diseño fijables sin tocar la UX

| Tema | Decisión | Evidencia que deberá aportar la implementación |
| --- | --- | --- |
| Autoridad | PostgreSQL contiene metadatos por beat/archivo. Telegram sigue almacenando medios; metadata GET/PATCH/trash/restore no toca INDEX/MASTER/Telegram después del corte | Tests spies y transacciones cortas, T03–T17 |
| Filtros | Gallery incluye **ANY** tags seleccionados; excluye cualquier tag rechazado; filtro de tags es exacto, no substring. Mantener ALL en consumidores que lo usen | T01 fixtures y T06 |
| Búsqueda | Pasar de búsqueda en página materializada a **búsqueda global antes de paginar**, registrando que es cambio deliberado de alcance | T06/T17, q 1–2 chars, tags, bpm, Unicode |
| Tamaño | API default 100 y máximo 240; Gallery debe solicitar 240 inicialmente para no cambiar la cantidad visible. Lotes de 50, cuotas comerciales intactas | T07/T14 |
| Conflictos | Una versión por beat; If-Match o expectedVersion; idempotency-key; epoch/fencing; nunca unir ediciones concurrentes por omisión | T05/T14 |
| Tenants | Aislar por usuario/generación/época; errores y caches de cuenta A no pueden revelar ni escribir cuenta B; cursor firmado con tenant y filtros | T05/T14 |
| Retención | 14 días como dato de papelera, sin purga automática; propuesta física mínima de 35 días. Propuesta de rollback 30 días con export ≤15 MiB | T04/T17; no afirmar backups todavía |
| SLO | Metadatos p95 ≤250 ms, p99 ≤1 s; pruebas 100k/1M beats; memoria/respuesta acotadas | T17, hardware/digest/EXPLAIN; son metas no mediciones |
| Desktop | Bibliotecas migradas bloqueadas para clientes antiguos hasta compatibilidad separada | Guard cliente en T14 |

**Fail closed:** los datos legacy no interpretables o que puedan perder referencias siguen en LEGACY/no elegibles para piloto, sin normalizar/borrar automáticamente.

## Dos decisiones pendientes de la IDE

### A. Unicode y nombre — STOP-DESIGN-A

`lower(name) COLLATE "C"` del plan NO equivale a `a.name.localeCompare(b.name)`. Este último depende de configuración locale/ICU del navegador; `C` usa otro orden. No fingir equivalencia ni ordenar solo los 240 ítems retornados.

**Encargo:** construir comparación sintética JavaScript Web/Edge con PostgreSQL 16.15, ICU disponible y `en_US.utf8`, sobre: `a,A,á,a\u0301,ä,ñ,n,z,Z,10,2,-,_,😀,🌙,İ,i,ı,ß,ss`, nombres duplicados, normalización NFC/NFD, empates y null/legacy. Elegir orden global total y keyset compatible, fijando collation/version, ordinal manual y beat ID; medir costo e índices. **Si cambia orden visible, presentar diferencia concreta y decisión de producto para aceptación explícita, o excluir biblioteca del piloto.**

Conservar semantics de manual (orden de entrada), BPM (`Number(bpm||0)`, incluidos inválidos legacy que no deben desaparecer), rating descendente y empate manual. Si un desempate SQL introduce una diferencia, documentarlo.

### B. Enlaces antiguos `bgPage` — STOP-DESIGN-B

Un link `/gallery?bgPage=240` pide el offset 240 de manifest. No convertirlo en “página 240”. No leer el INDEX entero, recorrer offsets sin límite ni afirmar que un cursor firmado corresponde al mismo ítem si cambió el orden.

**Encargo:** resolver `bgPage` una vez hacia cursor HMAC por tenant/epoch/revision/filtro/sort mediante operación acotada por tiempo/filas, y usar keyset para navegación normal. Decidir qué hacer con offsets profundos que no puedan convertirse con costo aceptable: estado UI visible y retorno explícito a primera página, no salto silencioso. Probar offsets `0,1,239,240,241,1e9`, negativos, fraccionales, `?bgPage=80#hash`, cambio de sort, sesión y revisión, 240/241 registros, 100k/1M. **No aceptar degradación visible sin aprobación de producto.**

## Contrato y tests para T01/T06/T14/T17

`GET /catalog/v1/beats`: estado, q, tags incluidos/excluidos, includeMode, sort, limit, cursor opaco; respuesta `{items,nextCursor,previousCursor,epoch,revision}`. Error 400 `CURSOR_INVALID`, 409 `CURSOR_STALE`, 410 `RESYNC_REQUIRED`. Cursor no reutilizable entre usuarios o cambios de filtros/sort/revision. Query SQL acotada por `user+generation+state`: `EXISTS` para ANY tags, `NOT EXISTS` para exclusión, index/pg_trgm para substring; LIMIT+1. No comparar `lower()` SQL con `toLowerCase()` JS sin fixtures Unicode. `String(bpm)` tampoco equivale siempre a representación SQL numérica; T01 debe cubrirlo.

- T01: inventario completo INDEX v1/v2, tombstones, garbage, media multipart, campos nulos/ausentes, orden/Unicode, rutas y offsets; fixtures sin red.
- T02: arnés de DB por run con URL allowlisted, identidad/propiedad/marker comprobados, tests de no borrar DB ajena; el probe G0 **no sustituye** T02.
- T03–T06: import/export sin pérdida, tenant, collation, filtros, keyset.
- T07/T14/T17: API + cambios de usuario/revision, UI/playback real, rendimiento y presupuestos medidos. Ningún objetivo C11 equivale a benchmark ya realizado.

## Evidencia disponible y puerta G0

Baseline T00 Windows: **68/68 PASS**, 25 mutaciones Cloud rechazadas, AST Cloud/TypeScript PASS. Laboratorio efímero [run 42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955): PostgreSQL **16.15**, UTF8, `en_US.utf8`, `pg_trgm 1.6`; marker de run/rol/DB confirmado, contenedores eliminados. No hay pruebas SQL reales de catálogo ni restauración/backup.

**C12 NO CERRADO** hasta resolver A y B con evidencia y registrar aceptación si hay cambio visible; en consecuencia **T00 global/G0 NO APROBADOS, T01 BLOQUEADA**. El prompt completo para la IDE está en `G0-C12-IDE-MASTER-PROMPT-20261107.md`; esta acta reduce trabajo repetido. No modificar aplicaciones/Cloud/INDEX hasta que ese gate pase.
