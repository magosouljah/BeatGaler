# T00 — Resultados reproducidos en BeatGaler LOCAL

**Fecha:** 7 de noviembre de 2026. **Estado:** `STOP-TEST`, sin PASS de T00 ni aprobación G0. Fuente: consola PowerShell aportada por el usuario, no ejecución remota en GitHub.

## Identidad verificable

- Carpeta LOCAL: `E:\777\app\BeatGaler`.
- Rama: `local/landing-gallery-unificada`.
- HEAD durante ejecución: `da735bed34733b5ed1e5e22a9d2e389d78bbad43`.
- Comparación con `31861e6`: únicamente documentación del catálogo; no se tocaron Landing, Gallery, Playbar ni Cloud.
- Archivos locales ajenos sin seguimiento: `Claude outputs/`, `beatgaler-console.jpg`. No versionados.
- PostgreSQL: 25 migraciones encontradas; NO se conectó a servidor ni se invocó migración.
- Node: 22.23.2; npm: 10.9.8.
- Evidencia original recibida: salida de 614 líneas, SHA-256 `4d3d3f1962efe5e1c99cafeb6b8d5a49bb1015d93d143835dd88958bb6a4864e`. No copiar logs completos a GitHub.

## Matriz de salida

| Fase del runner | PASS | FAIL | Exit code | Interpretación |
| --- | ---: | ---: | ---: | --- |
| E4: library quota / schema / PROJECT admission | 6 | 0 | 0 | Fakes/lectura de archivos, ningún PostgreSQL real. |
| PostgreSQL config/runner falsos y Direct Assignment | 3 | 0 | 0 | Doble de pool y validaciones locales. |
| Cloud source guard AST | n/a | n/a | 0 | Comprueba arquitectura original; guard pasó. |
| Cloud mutation guard en memoria | n/a | 1 fallo de script | 1 | La prueba no puede preparar una de sus mutaciones: ancla textual obsoleta. |
| DOM: Landing/Gallery/tags/UX/loader/selectores | 23 | 0 | 0 | Seis archivos de prueba, todos pasan. |
| Integración: tres suites legacy bootstrap | 24 | 3 | 1 | Asserts de punto de arranque antiguo. |
| TypeScript `--noEmit` | n/a | 0 | 0 | Compilación estática sin error. |

**56 pruebas individuales PASS; 3 pruebas individuales FAIL; 1 script de guard con exit 1** (4 fallos operativos). No equiparar los resultados de fakes a PostgreSQL real o playback con Telegram.

## STOP-TEST / Caso 1 — tres asserts antiguos de Direct

Archivos:

- `tests/integration/appStartupBootstrapExtraction.test.ts` exige `preconnectRememberedWebDirect();` y composición antigua de App en `src/main.tsx`.
- `tests/integration/issue97PlaybackOptimization.test.ts` exige import + llamada de Direct antes de `ReactDOM.createRoot`.
- `tests/integration/issue97RuntimeWebFollowup.test.ts` tiene la misma expectativa global.

**Hecho:** `src/main.tsx` arranca `WebExperience`; `src/app/WebGalleryWorkspace.tsx` importa `preconnectRememberedWebDirect` y lo llama en `useEffect` tras el gate autenticado. La ubicación anterior está obsoleta; no se ha demostrado aún la misma latencia ni el mismo orden de red. Tests de DOM relevantes y otros asserts heredados pasan.

**Tratamiento correcto futuro, bajo tarea de compatibilidad autorizada:** reemplazar asserts acoplados a ubicación literal por pruebas de comportamiento (Landing pública no inicializa Direct; Gallery autenticada conecta; logout/cambio de cuenta cancelan; Player reproduce y navega sin regresión). Conservar validación de orden y seguridad, no quitar ni comentar condiciones sin alternativa. No mover la preconexión al nivel global para forzar PASS.

## STOP-TEST / Caso 2 — guard Cloud con fixture desactualizada

- Archivo: `scripts/regression-direct-manager-only.test.mjs` línea 23–25, fallo en línea 76, mensaje `comment cannot install ownership wrapper: mutation anchor must exist`.
- **Ancla exigida:** `installPersistentDirectSessionStart({ directTransport, persistentAssignments: directPersistentAssignments });`.
- **Runtime actual:** `cloud-server/server.js`, llamada `installPersistentDirectSessionStart({ directTransport, persistentAssignments: directPersistentAssignments, indexPinAuthority });`.
- El guard principal `scripts/regression-direct-manager-only.mjs` AST PASÓ. La fixture del mutation test falla antes de verificar que un comentario no puede simular la llamada. No es evidencia de que el servidor haya perdido el wrapper.

**Tratamiento futuro:** actualizar la fixture para reflejar exactamente la invocación actual de tres propiedades y demostrar que el guard AST sigue rechazando si la llamada se reemplaza por un comentario; repetir TODAS las mutaciones, no solo eliminar la fallida. No tocar código productivo para insertar un literal viejo.

## Otras condiciones pendientes de T00

1. **STOP-ENV:** descriptor verificado de PostgreSQL descartable, separado de cualquier DB real; versión/colación/`pg_trgm` no comprobados. Prohibido `postgres-live.integration.cjs` sobre entorno heredado (`DROP SCHEMA public CASCADE`).
2. **STOP-DESIGN:** cerrar C12 de forma explícita; no imponer `lower(name) COLLATE "C"` como equivalencia de `localeCompare`; definir compatibilidad `bgPage`/cursores, límites/SLO y preservar filtros ANY + exclusiones.
3. **Aceptación funcional:** además de DOM/typecheck, falta validar Direct autenticado/Player con los medios y el entorno adecuados. Ningún test de fakes demuestra su funcionamiento contra Telegram real.
4. **AGENTS no versionados:** el runner comprobó los ancestros principales y habría parado si los encontraba; no declara ausencia en toda carpeta local.

## Cierre

**T00 = STOP-TEST / NO PASS. G0 = NO APROBADO. T01 = BLOQUEADA.** No se ha implementado PostgreSQL, cambiado la UI, iniciado AWS ni actuado sobre Telegram/DB real. La siguiente fase debe abordar estos dos tests obsoletos con pruebas de comportamiento y un entorno laboratorio seguro antes de volver a certificar T00; no ejecutar T01 por defecto.
