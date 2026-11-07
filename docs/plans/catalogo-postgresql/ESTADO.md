# Estado de ejecución y transferencia

Actualizado: 7 de noviembre de 2026.

**Entregable actual:** plan documental terminado. **Implementación:** no iniciada. **Migraciones reales:** ninguna. **Autorización actual:** análisis y elaboración del plan; no implementación ni servicios reales.

Base inspeccionada: `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`, rama `local/landing-gallery-unificada`. Referencia `main` local `10ae1908d947cc4f6981469f9a722936ec3ee57e`. No fetch ni verificación de producción.

La ejecución de seis pruebas locales en EVIDENCIA/E4 terminó PASS. No es PASS de las tareas futuras ni de sus puertas. Los nuevos comandos, tablas, módulos y APIs descritos todavía no existen.

| Tarea | Estado | Evidencia de implementación |
| --- | --- | --- |
| T00 Base/contrato | **STOP-TEST / NO PASS** | [T00-LOCAL-RESULTADOS-20261107.md](T00-LOCAL-RESULTADOS-20261107.md): 56 tests PASS, 3 FAIL; guard Cloud in-memory exit 1. STOP-ENV/DESIGN pendientes. |
| T01 Campos/consumidores | PENDIENTE | — |
| T02 Arnés aislado | PENDIENTE | — |
| T03 Esquema | PENDIENTE | — |
| T04 Codec/import/export | PENDIENTE | — |
| T05 Autoridad/época | PENDIENTE | — |
| T06 Lectura/API | PENDIENTE | — |
| T07 Mutaciones metadata | PENDIENTE | — |
| T08 Cliente lectura/eventos | PENDIENTE | — |
| T09 Operaciones/reservas | PENDIENTE | — |
| T10 Worker | PENDIENTE | — |
| T11 Telegram real aislado | PENDIENTE | — |
| T12 Transferencias/PROJECT | PENDIENTE | — |
| T13 Cliente mutaciones | PENDIENTE | — |
| T14 Playback/downloads | PENDIENTE | — |
| T15 Purge/retención | PENDIENTE | — |
| T16 Arranque/cercado | PENDIENTE | — |
| T17 CLI migración | PENDIENTE | — |
| T18 Ensayo rollback | PENDIENTE | — |
| T19 Restore/backups | PENDIENTE | — |
| T20 Performance | PENDIENTE | — |
| T21 Candidato/revisión | PENDIENTE | — |
| T22 Sombra real | PENDIENTE | — |
| T23 Piloto | PENDIENTE | — |
| T24 Cohortes/cleanup | PENDIENTE | — |
| T25 Retirada | PENDIENTE | — |

G0, G1, G2, G3, G4: **PENDIENTES**. El plan contiene decisiones propuestas concretas y comprobaciones para cerrarlas. No hay GO productivo.

## Registro de una tarea completada

Copiar por cada ejecución, sin borrar antecedentes:

```text
Tarea / fecha / ejecutor:
Encargo y alcance autorizado:
Rama / worktree / SHA inicial / SHA final (o sin commit):
Estado inicial de archivos ajenos y preservación:
Dependencias PASS y enlaces a evidencia:
Entorno y descriptor (sin credenciales):
Archivos creados/modificados:
Cambios de comportamiento:
Comandos exactos ejecutados + exit codes:
Pruebas totales / PASS / FAIL / SKIP:
Artefactos y hashes:
Resultado: PASS | PASS-AISLADO | STOP-...
Puerta que queda abierta/cerrada:
Próxima tarea habilitada (no iniciarla automáticamente):
```

## Expediente para escalar a alta capacidad

```text
STOP-<código> — Tarea T__ — Paso exacto:
Qué exigía el contrato (C__/M__):
Qué se observó y dónde está la evidencia:
Reproducción mínima / comando / exit code:
Hechos comprobados:
Hipótesis todavía no comprobadas:
Datos/operaciones afectados (IDs redactados fuera del artefacto protegido):
Autoridad / epoch / estado / última operación confirmada:
¿Hay un efecto externo en vuelo o incierto?:
Archivos y servicios modificados:
Medida de contención autorizada ejecutada, si existe:
Qué NO se ejecutó:
Decisión concreta que debe tomar la inteligencia de alta capacidad:
```

No sustituir este expediente por “no pude”, “parece un problema de Telegram” o un intento de reparación no autorizado. Una vez emitido STOP, la IA ejecutora espera una instrucción nueva.


## Estado actualizado al baseline LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
- Checkout auditado localmente por script: rama `local/landing-gallery-unificada`, commit `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b` (esto verifica solo identidad/parentesco, NO ejecución de tests).
- Referencia visual/funcional de integración: `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`.
- Árbol Cloud igual que base histórica en snapshot GitHub: `bcb488ae3802dfd2bbe8f3fe6245b314a152c189`.
- **G0: PENDIENTE** de examen completo de documentos, DB test aislada (issue #133), baseline CI/Direct, DTO UI/API, equivalencia del INDEX, smoke local y revisión de diffs no confirmados.
- 26 tareas y gates G0–G4: **estados previos conservados**, no se declara ninguna completada mediante esta actualización documental.
- No hay implementación ni migración SQL realizada por este script.

Ver [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md).

## Resultado de auditoría G0 estática — 2026-11-07

- **G0: NO APROBADO** (`STOP-ENV`, `STOP-TEST`, `STOP-DESIGN`). **T00: PENDIENTE. T01: BLOQUEADA** por dependencia. Ninguna tarea se inició.
- Rama `local/landing-gallery-unificada`; fuente remota de auditoría `edabd715664f9564346e95b8553b68b4ac411da9`; código de referencia `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`. Solo cambió documentación.
- Evidencia: siete archivos y código remoto, salida Git del usuario. Los seis PASS E4 proceden de ejecución anterior; **cero tests nuevos ejecutados aquí**.
- Pendientes antes de T01: T00 PASS autorizado, descriptor DB segura, baseline reproducible de Web/Cloud/Direct y clasificación de fallo #151, decisión C12 sobre orden/Unicode/compatibilidad `bgPage` y SLO, pruebas de Landing/Gallery/Playbar.
- [Informe G0 completo](G0-AUDITORIA-20261107.md). No habilita AWS, Telegram, DB real ni despliegue.

## T00 — iniciado, sin PASS (2026-11-07)

- **Autorización:** el usuario indicó «go» para continuar con T00 en LOCAL; no autorizó infraestructura, credenciales, Telegram, PostgreSQL real, migración ni T01.
- **Base:** usuario confirmó `f90b488` en `local/landing-gallery-unificada`, fast-forward sin cambios de aplicación; dos elementos ajenos sin seguimiento permanecen intactos.
- **Evidencia estática nueva:** 25 migraciones 0001–0025; 1211 entradas del árbol GitHub; sin `AGENTS.md` versionados; manifests/lockfiles leídos; seis pruebas E4 históricas y otras suites inspeccionadas **sin reejecutar**.
- **Resultado T00:** `EN CURSO / NO PASS` por `STOP-ENV` (sin descriptor PostgreSQL aislado), `STOP-TEST` (sin resultados Windows/Direct/Playbar actuales), `STOP-DESIGN` (C12 sin aceptación y fixtures Unicode/offset). No se declara ningún test aprobado en esta ejecución. **T01 continúa BLOQUEADA**.
- **Comprobación segura preparada:** [T00-BASELINE-READONLY.ps1](T00-BASELINE-READONLY.ps1); únicamente comandos Git y tests locales permitidos. Tras inspeccionar resultados, completar T00 con evidencia; no promover PASS por omisión.
- **Expediente técnico:** [T00-REVISION-20261107.md](T00-REVISION-20261107.md).

### Actualización CI histórico (T00)

Logs examinados del run `42353075806`: PostgreSQL persistent assignment PASS histórico; TypeScript Direct 3 FAIL/188 PASS por tres asserts de bootstrap antiguo; Cloud guard FAIL por ancla literal de mutación. La clasificación es de **fallo de aserción observado**, no prueba de equivalencia funcional ni PASS actual. El runner T00 incluye las suites afectadas y el guard. `STOP-TEST` permanece abierto.

## T00 — Resultado ejecutado en Windows LOCAL (2026-11-07)

- Usuario ejecutó `T00-BASELINE-READONLY.ps1` después de fast-forward a `da735bed34733b5ed1e5e22a9d2e389d78bbad43`, rama correcta. `git status`: solo `Claude outputs/` y `beatgaler-console.jpg` sin seguimiento. 25 migraciones, Node 22.23.2 y npm 10.9.8 confirmados.
- **PASS:** 6 pruebas E4, 3 de config/runner/Direct simulado, 23 de DOM/Gallery y 24 de 27 de tests de arranque heredado; check AST Cloud exit 0 y TypeScript `--noEmit` exit 0.
- **FAIL:** 3 tests de integración de arranque Direct, todos por exigir `src/main.tsx` anterior; script de mutaciones de guard Cloud exit 1 al faltar ancla literal con 2 argumentos (el runtime tiene `indexPinAuthority` como tercero). El guard AST original PASÓ, de modo que el fallo del test mutante es de preparación de fixture, no evidencia de ruptura del guard real. Con todo, no demuestra que la nueva ruta de Direct sea funcionalmente equivalente.
- **Dictamen:** `T00 = STOP-TEST / NO PASS`; `STOP-ENV` por falta de descriptor PostgreSQL aislado, `STOP-DESIGN` por falta de cierre C12. `G0 = NO APROBADO`; `T01 = BLOQUEADA`. No se iniciaron T01 ni T02 y no se autorizan servicios reales.
- **Expediente detallado:** [T00-LOCAL-RESULTADOS-20261107.md](T00-LOCAL-RESULTADOS-20261107.md). Evidencia obtenida de salida aportada por el usuario, no ejecutada remotamente por GitHub.

## Reparación de pruebas T00 enviada (2026-11-07)

Corrección limitada a cuatro tests existentes, un test DOM nuevo y el runner documental; 25 anclas de mutación verificadas por lectura estática, **sin ejecutar la nueva suite todavía**. PostgreSQL 16 Docker digest de CI es solo referente para laboratorio, no servidor Windows verificado. C12 sigue STOP-DESIGN y entorno STOP-ENV. T00 NO PASS; T01 BLOQUEADA. Ver [T00-TEST-CORRECTIONS-20261107.md](T00-TEST-CORRECTIONS-20261107.md).

### Reparación del guard de alcance del runner — 2026-11-07

El usuario actualizó LOCAL a `b5d23fc`; el runner T00 se detuvo en `STOP-BASE` antes de ejecutar tests porque la revisión original permitía exclusivamente `docs/plans/catalogo-postgresql/`, pero las pruebas T00 autorizadas habían cambiado cinco archivos `tests/`/`scripts/`. **No es fallo de app, Cloud ni PostgreSQL.** Se sustituyó por una allowlist exacta de esos cinco paths; continúa el bloqueo para `src/`, `cloud-server/`, migraciones, `DESIGN/`, UI y cualquier otro archivo inesperado. Nueva ejecución Windows todavía PENDIENTE; T00 sin PASS, T01 bloqueada.
