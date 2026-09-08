from pathlib import Path

roadmap = Path('migration/BeatGaler-roadmap-para-trabajar-con-IAs.md')
text = roadmap.read_text()
old = '### [ ] 5.3 — Separar proyectos'
new = '### [x] 5.3 — Separar proyectos'
if text.count(old) != 1:
    raise SystemExit(f'expected exactly one unchecked 5.3 entry, got {text.count(old)}')
roadmap.write_text(text.replace(old, new, 1))

register = Path('migration/Registro-de-avance.md')
text = register.read_text()
if '### Registro — 5.3' in text:
    raise SystemExit('5.3 register entry already exists')
entry = r'''

### Registro — 5.3

```
Tarea: 5.3 — Separar proyectos
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: aad232955feafedf07174a1f4cd137072deb7fb4
- Última tarea verificada: 5.2 — Separar reemplazo de archivos de un beat

Cambio realizado

- Se creó `src/features/projects/useBeatProjects.ts` como dueño de apertura, subida/actualización explícita, reemplazo PROJECT, autoinspección de drops e indicadores de disponibilidad de proyectos.
- `App.tsx` compone `useBeatProjects` y dejó de poseer directamente `handleOpenProject`, `handleUploadProjectTelegram`, `handleUpdateProject`, `hasStoredProject`, `startProjectAssetUpdate`, `startProjectZipReplacement`, `handleAutoProjectDrop`, refresh de indicadores y estado del aviso PROJECT.
- Se conservaron las rutas Desktop de PROJECT file/folder/ZIP, validación, confirmación Replace/Cancel, limpieza de staging y filtrado/avisos de Backup/Backups.
- Web conserva `platform.editor.commit(..., { PROJECT: file })`, actualización de biblioteca/Drawer y transiciones runtime, ahora dentro del módulo de proyectos.
- La actualización de indicadores sigue reaccionando a cambios de beats y a `beatgaler:project-cloud-changed` / `beatgaler:project-cloud-updated`.
- El pipeline automático de subida inicial de beats conserva temporalmente en `App.tsx` su etapa multi-slot que consulta/sube PROJECT junto con MASTER/WAV; no es la operación interactiva de proyecto y se deja como conexión temporal para una extracción cloud posterior.

Adaptación de pruebas

- Se añadió `tests/integration/appBeatProjectsExtraction.test.ts` para proteger ownership, reemplazo, Backup/Backups, rutas Desktop/Web e indicadores.
- `tests/integration/appBeatAssetUpdatesExtraction.test.ts` dejó de exigir la frontera temporal anterior con PROJECT.
- `tests/integration/issue97WebRoutingContract.test.ts` cambió únicamente su marcador físico de sección para seguir protegiendo el orden del flujo artwork tras mover el bloque PROJECT.
- `scripts/regression-phase9cd.mjs` y `scripts/run-regressions.mjs` continúan protegiendo los mismos contratos PROJECT leyendo la implementación desde su nuevo owner; el routing de folder que permanece en App sigue protegido como conexión de composición.
- No se debilitó ningún comportamiento para hacer pasar pruebas.

Archivos afectados

- src/App.tsx
- src/features/projects/useBeatProjects.ts
- tests/integration/appBeatProjectsExtraction.test.ts
- tests/integration/appBeatAssetUpdatesExtraction.test.ts
- tests/integration/issue97WebRoutingContract.test.ts
- scripts/regression-phase9cd.mjs
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.3 Apply`, run 34240215318 — SUCCESS.
- Artifact `migration-check-logs-task-5-3-34240215318` leído: `summary.txt` confirma PASS en toda la matriz.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.
- SHA de implementación verificada: 1d29c9cb1f17c33cf88527851e6afb244600447c.

Comprobaciones no ejecutadas

- npm run check — no requerido; la matriz ejecutó individualmente los checks relevantes del plan.
- E2E completos de import/download/recovery — no aplican a esta extracción de ownership PROJECT.
- Prueba física Desktop Windows/macOS — no ejecutada; esta ronda opera mediante GitHub Actions y no dispone de aplicación física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop: abrir un proyecto disponible, subir/actualizar PROJECT, reemplazar PROJECT ZIP y project file, cancelar reemplazo y probar carpeta con Backup/Backups.
- Web: reemplazar PROJECT ZIP en un beat y comprobar actualización de Drawer/biblioteca.
- Resultado esperado: mismo comportamiento observable anterior, avisos y filtrado Backup/Backups conservados, card busy durante trabajo y disponibilidad actualizada al terminar.

Pendientes / fuera de alcance

- 5.4 — Separar Available Offline permanece pendiente y no fue iniciada.
- El pipeline automático de subida inicial conserva su etapa PROJECT dentro de la orquestación multi-slot de `App.tsx`; mover esa orquestación corresponde a una extracción cloud posterior, no a esta ronda.
- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto quedó abierto por 5.3.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.

Herramientas temporales restantes

- Ninguna creada por 5.3 permanece tras el commit de implementación/cierre.

Fallos encontrados y causa

- Run 34239199329 y run 34239422217: la definición inicial del workflow temporal era inválida y GitHub no creó jobs; no publicaron cambios de producto.
- Run 34239445621: fallaron typecheck, integration, regressions y ambos builds. Causa: la primera extracción retiró dos dependencias PROJECT que aún pertenecen al pipeline automático multi-slot, dejó el cierre del aviso apuntando al setter movido y dos pruebas/guards seguían acoplados a la ubicación física anterior. Unit TS y component DOM ya pasaban. Se corrigió ownership/composición sin alterar contratos.
- Run 34239904704: typecheck, unit TS, component DOM, integration y ambos builds pasaron; solo regressions falló porque un guard aún buscaba `inspectProjectDropSource` en `App.tsx`. Se movió el guard al owner real.
- Run 34240215318: toda la matriz terminó PASS y publicó la implementación.

Veredicto

Terminada.

Las operaciones interactivas PROJECT y sus indicadores quedaron fuera de `App.tsx`, con las reglas ZIP, Backup/Backups, rutas Web/Desktop, estados y avisos preservados por la matriz completa.

Siguiente tarea

5.4 — Separar Available Offline.

No iniciada.
```
'''
register.write_text(text.rstrip() + entry + '\n')

state = Path('migration/BeatGaler-agent-state.md')
state.write_text(r'''# BeatGaler — Agent State

Fecha de ejecución: 2026-09-08
Rama de trabajo obligatoria: `v0.9.0-test-noche`

## Estado actual

- Tarea trabajada: **5.3 — Separar proyectos**
- Estado: **Terminada**
- Última tarea terminada: **5.3 — Separar proyectos**
- SHA inicial de esta ejecución: `aad232955feafedf07174a1f4cd137072deb7fb4`
- SHA final de implementación verificada: `1d29c9cb1f17c33cf88527851e6afb244600447c`
- Run de verificación principal: **34240215318 — SUCCESS**
- Comprobaciones pendientes para 5.3: **ninguna**

## Resultado verificado

- `useBeatProjects` posee apertura, subida/actualización interactiva, reemplazo, autoinspección y disponibilidad de PROJECT.
- Se conservaron las reglas PROJECT ZIP, confirmaciones, Backup/Backups, cleanup, estados runtime y rutas distintas Web/Desktop.
- Los indicadores se refrescan por cambios de biblioteca y eventos project-cloud.
- `summary.txt` del artifact `migration-check-logs-task-5-3-34240215318` confirma PASS en typecheck, unit TS, component DOM, integration, regressions, build:web y build.

## Pendientes concretos / fuera de alcance

- El pipeline automático multi-slot de subida inicial conserva temporalmente su etapa PROJECT en `App.tsx`; corresponde a una extracción cloud posterior.
- Riesgo previo de `handleRemoveBulk` con snapshots capturados: permanece sin cambios y fuera del alcance de 5.3.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.
- No quedan herramientas temporales creadas por 5.3 en el árbol final.

## Siguiente tarea

- **5.4 — Separar Available Offline**
- Estado: **Pendiente**
- No iniciarla hasta la próxima ronda.
''')
