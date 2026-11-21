# T00 — Baseline completo de pruebas LOCAL, 2026-11-07

**Fuente:** ejecución PowerShell copiada por el usuario desde `E:\777\app\BeatGaler` sobre `5b199161351a05c62df79870d563cd7aceb5572f`, rama `local/landing-gallery-unificada`.

## Resultados verificados a partir de la salida

| Fase | Tests | Resultado |
| --- | --- | --- |
| E4: cuota, esquema, PROJECT | 6 | PASS |
| PostgreSQL config/runner fake y Direct assignment | 3 | PASS |
| Cloud source guard AST | no lista tests individuales | PASS, exit 0 |
| Cloud mutation guard | 25 mutaciones peligrosas rechazadas | PASS, exit 0 |
| DOM: Landing, Gallery, Auth, tags, loader, selectors, preconnect | 32 | PASS |
| Tres suites integration Direct bootstrap | 27 | PASS |
| TypeScript `--noEmit` | compilación | PASS, exit 0 |

**Conteo total:** 68/68 tests individuales PASS, 0 FAIL; además 25/25 mutaciones rechazadas; 7/7 fases del runner exit 0. Los 25 escenarios de mutación no se suman al conteo de 68.

**Observación:** Vitest/React emitió la advertencia `A suspended resource finished loading inside a test, but the event was not wrapped in act(...)` en el caso de sesión sin autenticar. La prueba correspondiente pasó. Registrar como deuda de calidad de fixture de suspense, no ocultar ni declararla fallo funcional. El resultado no equivale a smoke real de audio/playback ni a PostgreSQL conectado.

## Identidad y aislamiento

- Branch `local/landing-gallery-unificada`; HEAD `5b19916`. Comparación desde `31861e6`: solo documentación del catálogo y cinco archivos de pruebas T00 aprobados.
- `git status --short`: archivos ajenos `Claude outputs/` y `beatgaler-console.jpg` sin seguimiento, sin modificaciones.
- 25 migraciones `0001`–`0025` encontradas.
- Node `v22.23.2`; npm `10.9.8`.
- `docker`, `podman`, `psql`: no disponibles en PATH Windows. No significa necesariamente que no exista algún servidor instalado.
- El ejecutor no conectó a DB, AWS, Telegram ni producción y no ejecutó `postgres-live.integration.cjs` destructivo.

## Decisión sobre TEST

**STOP-TEST del baseline T00: resuelto para las siete fases whitelist, con advertencia no bloqueante de React.** Este PASS de baseline no implica que todas las pruebas de G0 (por ejemplo reproducción real con medios) hayan sido ejecutadas.

T00 **continúa NO PASS**: `STOP-ENV` (descriptor de DB aislada no comprobado) y `STOP-DESIGN` (C12 no aceptado). G0 **NO APROBADO**; T01 **BLOQUEADA** por la secuencia registrada en `TAREAS.md`.

## Propuesta de laboratorio PostgreSQL sin instalar software en Windows

- Ya existe una definición de contenedor PostgreSQL en `.github/workflows/direct-persistent-vault-assignment.yml`: `postgres:16@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109` como service de GitHub Actions Linux.
- **Recomendación técnica para T02:** definir un workflow independiente y manual de catálogo con PostgreSQL desechable y DB dedicada generada por run. No reutilizar el servicio ni la DB de asignación persistente como si fueran de catálogo; no conectar por variables heredadas.
- Requerir en el arranque que se imprima a los artefactos no sensibles `server_version` exacta, `lc_collate`, `lc_ctype`, encoding, disponibilidad de `pg_trgm` y propiedad de la base. Registrar digest, OS, límites relevantes, rol local sin privilegios de bases ajenas y marcador único de laboratorio.
- No lanzar el workflow, no provisionar recursos ni ejecutar SQL en T00. El contenedor del CI existente es **referencia**; todavía falta el descriptor verificado por ejecución en un servicio exclusivamente asignado al catálogo. No usar `postgres-live.integration.cjs` sin arnés de aislamiento (contiene `DROP SCHEMA public CASCADE`).

## C12 pendiente sin cambios silenciosos

1. Orden `name`: `String.localeCompare` de JS y `lower(name) COLLATE "C"` SQL no dan paridad garantizada para Unicode. T00 no debe asumir un cambio de orden visible; proponer paridad donde sea verificable con fixtures y documentar incompatibilidades antes de T06.
2. Filtros: conservar interpretación real Web (inclusión ANY para Gallery y exclusión NONE) y aplicar búsqueda global antes de paginar.
3. Bookmarks `bgPage`: conservar links viejos y definir conversión segura y acotada hacia cursores para páginas profundas, sin índice entero ni bucle indefinido; propuesta y límites requieren aceptación explícita.
4. SLO 100k/1M, latencias, retención, RPO/RTO y backup: propuestas sin medición productiva, no vender como certificaciones.

**Estado formal:** pruebas T00 whitelist `PASS`; T00 global `STOP-ENV + STOP-DESIGN`; G0 `NO APROBADO`; T01 `BLOQUEADA`.
