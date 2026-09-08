from pathlib import Path

roadmap = Path('migration/BeatGaler-roadmap-para-trabajar-con-IAs.md')
text = roadmap.read_text()
old = '### [ ] 5.1 — Separar guardado de metadata y artwork'
new = '### [x] 5.1 — Separar guardado de metadata y artwork'
if new not in text:
    if old not in text:
        raise SystemExit('5.1 roadmap marker missing')
    text = text.replace(old, new, 1)
roadmap.write_text(text)

registro = Path('migration/Registro-de-avance.md')
r = registro.read_text()
marker = '### Registro — 5.1'
if marker in r:
    raise SystemExit('5.1 registry entry already exists; refusing duplicate')
entry = r'''

### Registro — 5.1

```
Tarea: 5.1 — Separar guardado de metadata y artwork
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: d2afff16996ef1bff658d4604c75b9e1eb8609a9
- Última tarea verificada: 4.3 — Separar la cola y navegación

Cambio realizado

- Se creó `src/features/edit/useDrawerCloudPersistence.ts` como dueño del observer de metadata Desktop, su debounce por beat de 700 ms, la sincronización metadata/artwork, el commit del INDEX y la deduplicación de commits del Drawer.
- `App.tsx` dejó de poseer los timers y refs de deduplicación y ahora compone `useDrawerCloudPersistence`, conservando el mismo callback `commitDrawerCloudMutation` que ya consume `Drawer.tsx`.
- Se preservaron las condiciones Web/Desktop: Web retorna antes del observer legado y mantiene sus commits explícitos por `platform.editor`; Desktop conserva el observer, estados runtime y sincronización Telegram/INDEX.
- Se preservó el orden de guardado: metadata/artwork primero cuando corresponde, después snapshot autoritativo del INDEX y finalmente siembra de fingerprints para evitar un segundo guardado.
- `Drawer.tsx` no fue reorganizado y las operaciones de reemplazo de MASTER/WAV/assets permanecen fuera de esta extracción.

Adaptación de pruebas

- `tests/integration/issue97WebRoutingContract.test.ts` sigue protegiendo que Web no instala el observer Desktop, pero ahora inspecciona el módulo que realmente posee esa responsabilidad.
- `scripts/run-regressions.mjs` sigue exigiendo los marcadores y refs de deduplicación, pero los busca en `useDrawerCloudPersistence.ts` en vez de exigir que permanezcan físicamente en `App.tsx`.
- Estas adaptaciones corrigieron acoplamientos a ubicación interna; no se relajaron los contratos protegidos.

Archivos afectados

- src/App.tsx
- src/features/edit/useDrawerCloudPersistence.ts
- tests/integration/issue97WebRoutingContract.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.1 Apply`, run 34230769729 — SUCCESS.
- GitHub Actions `Task 5.1 Migration Checks`, run 34230888488 — FAILURE inicial. Artifact `migration-check-logs-task-5-1-34230888488` leído: typecheck, unit TS, component DOM, build:web y build PASS; integration/regressions fallaron por assertions acopladas a la ubicación anterior; diff-check no pudo resolver el SHA inicial por checkout shallow.
- GitHub Actions `Task 5.1 Adapt Dedupe Regression`, run 34231568800 — SUCCESS.
- GitHub Actions `Task 5.1 Migration Checks`, run 34231857530 — SUCCESS. Artifact `migration-check-logs-task-5-1-34231857530`, `summary.txt` leído: todos los checks PASS.
- git diff --check d2afff16996ef1bff658d4604c75b9e1eb8609a9..HEAD — PASS.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.
- SHA de implementación/verificación: 90c981976d0e23499d50be80b54e96ef51eeaf7c.

Comprobaciones no ejecutadas

- npm run check — no necesario para esta extracción; los checks relevantes del wrapper se ejecutaron individualmente y quedaron verdes.
- E2E completos de import/download/recovery — no aplican al ownership de metadata/artwork del Drawer.
- Prueba física Desktop Windows/macOS — no ejecutada porque esta ronda opera mediante GitHub Actions y no dispone de una aplicación física interactiva; no es requisito de cierre dado que routing, dedupe, integración, regresiones y ambos builds quedaron cubiertos automáticamente.

Prueba manual

- No ejecutada ni inventada.
- Desktop: abrir un beat, cambiar metadata y/o artwork, guardar, recargar la biblioteca y comprobar persistencia y una sola transacción lógica metadata/artwork + INDEX.
- Web: editar metadata/artwork y comprobar que sigue la ruta `platform.editor`, sin invocar el observer Tauri Desktop.
- Resultado esperado: mismo estado persistido que antes de la extracción y ausencia de un segundo commit duplicado.

Pendientes / fuera de alcance

- 5.2 — Separar reemplazo de archivos de un beat permanece pendiente y no fue iniciada.
- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto identificado por 5.1.
- Existe previamente `.github/workflows/probe-task-5.1-productive-temp-auth-compile.yml`; no pertenece a esta extracción y no se modificó ni eliminó.

Herramientas temporales restantes

- Ninguna creada por esta ronda permanece en el árbol final.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` permanece porque ya existía antes de esta ejecución.

Fallos encontrados y causa

- Run 34230888488: integration y regressions fallaron porque dos pruebas existentes estaban acopladas a que el observer y las refs de dedupe vivieran físicamente en `App.tsx`. El comportamiento protegido seguía presente en el nuevo módulo; se adaptaron las pruebas al nuevo ownership sin debilitarlas.
- En ese mismo run, `diff-check` falló por `Invalid revision range` porque el workflow temporal usaba checkout shallow; se corrigió a `fetch-depth: 0`.
- Run 34231349409: el primer applier de adaptación de tests falló antes de publicar cambios porque su búsqueda textual exacta no encontró el bloque; fue un fallo de tooling temporal, no del producto.
- Run 34232243698: el primer finalizador documental fue rechazado por GitHub antes de crear jobs; no ejecutó comandos ni modificó documentación/producto.

Veredicto

Terminada.

El guardado de metadata/artwork y su protección contra duplicados quedaron fuera de `App.tsx` conservando orden, debounce, condiciones Web/Desktop y las mismas escrituras lógicas verificadas por integración, regresiones y builds.

Siguiente tarea

5.2 — Separar reemplazo de archivos de un beat.

No iniciada.
```
'''
registro.write_text(r.rstrip('\n') + entry + '\n')

agent = Path('migration/BeatGaler-agent-state.md')
agent.write_text('''# BeatGaler — Agent State

Fecha de ejecución: 2026-09-08
Rama de trabajo obligatoria: `v0.9.0-test-noche`

## Estado actual

- Tarea trabajada: **5.1 — Separar guardado de metadata y artwork**
- Estado: **Terminada**
- Última tarea terminada: **5.1 — Separar guardado de metadata y artwork**
- SHA inicial de esta ejecución: `d2afff16996ef1bff658d4604c75b9e1eb8609a9`
- SHA final de implementación verificada: `90c981976d0e23499d50be80b54e96ef51eeaf7c`
- Run de verificación principal: **34231857530 — SUCCESS**
- Comprobaciones pendientes para 5.1: **ninguna**

## Resultado verificado

- `useDrawerCloudPersistence` posee el observer Desktop, el debounce de 700 ms, el commit metadata/artwork + INDEX y los refs que deduplican guardados del Drawer.
- Web conserva la salida temprana del observer legado y Desktop conserva su ruta de sincronización y estados runtime.
- `Drawer.tsx` continúa conectado mediante el mismo callback y no fue reorganizado.
- `summary.txt` del artifact `migration-check-logs-task-5-1-34231857530` confirma PASS en diff-check, typecheck, unit TS, component DOM, integration, regressions, build:web y build.

## Pendientes concretos / fuera de alcance

- Riesgo previo de `handleRemoveBulk` con snapshots capturados: permanece sin cambios y fuera del alcance de 5.1.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.
- No quedan herramientas temporales creadas por 5.1 en el árbol tras el commit de cierre.

## Siguiente tarea

- **5.2 — Separar reemplazo de archivos de un beat**
- Estado: **Pendiente**
- No iniciarla hasta la próxima ronda.
''')
