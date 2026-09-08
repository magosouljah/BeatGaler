from pathlib import Path

ROADMAP = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
REGISTRO = Path("migration/Registro-de-avance.md")
AGENT = Path("migration/BeatGaler-agent-state.md")

roadmap = ROADMAP.read_text()
old = "### [ ] 5.5 — Separar papelera y restauración"
new = "### [x] 5.5 — Separar papelera y restauración"
if roadmap.count(old) != 1:
    raise SystemExit(f"expected one unchecked 5.5, found {roadmap.count(old)}")
ROADMAP.write_text(roadmap.replace(old, new, 1))

registro = REGISTRO.read_text().rstrip()
if "### Registro — 5.5" in registro:
    raise SystemExit("Registro 5.5 already exists")
entry = r'''

### Registro — 5.5

```
Tarea: 5.5 — Separar papelera y restauración
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 99ec3ad8f27eecad526623a7816971121e33c6ef
- Última tarea verificada: 5.4 — Separar Available Offline

Cambio realizado

- Se creó `src/features/trash/useTrashActions.ts` como owner del borrado individual, borrado masivo y restauración desde Settings.
- `App.tsx` dejó de poseer esos handlers y sus llamadas directas a `recordOfflineTrashIntent`/`removeBeatFromLibrary`; ahora compone el hook.
- Se conservaron confirmaciones/avisos, liberación del audio activo en borrado individual, estados runtime, intents offline y los commits online `move-to-trash`/`bulk-remove`.
- Restore online conserva la regla de no publicar un segundo índice: siembra snapshots, actualiza la vista e hidrata artwork sin llamar `commitSnapshot`; offline sigue recargando `loadOfflineLibrary`.
- No se inició 5.6.

Adaptación de pruebas

- `scripts/run-regressions.mjs` ahora valida las transiciones Trash en el nuevo owner.
- Se añadió un guard de ownership que exige delete/bulk/restore en `useTrashActions`, los dos límites de commit de borrado y ausencia de `commitSnapshot` en restore.
- No se relajaron los guards existentes de Trash, biblioteca vacía, reconciliación offline, Direct index ni runtime.

Archivos afectados

- src/App.tsx
- src/features/trash/useTrashActions.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.5 Trash Actions Applier`, run 34246285595 — SUCCESS.
- `node scripts/run-migration-checks-with-logs.mjs` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- `git diff --check` — PASS antes del commit de implementación.
- SHA de implementación verificada: c5b9843cd093a008a0adaa8a615327c060a7802c.

Comprobaciones no ejecutadas

- `npm run check` — no necesario; la matriz ejecutó individualmente los checks aplicables.
- E2E completos de import/upload/download — fuera del alcance de esta extracción Trash.
- Prueba física Desktop Windows/macOS — no disponible en esta ejecución; no bloquea porque los servicios nativos de Trash/restauración no cambiaron y los contratos quedaron cubiertos por regressions y ambos builds.
- Artifact `migration-check-logs-*` del run exitoso — no generado; el workflow temporal solo lo sube si falla la matriz.

Prueba manual

- No ejecutada ni inventada.
- Desktop online: eliminar un beat reproduciéndose, eliminar varios beats cloud, restaurar desde Settings y recargar.
- Desktop offline: mover uno/varios beats cloud a Trash, restaurar localmente y después reconectar.
- Resultado esperado: mismos avisos, audio liberado, no resurrección tras recarga y restore sin segunda publicación de índice.

Pendientes / fuera de alcance

- 5.6 — Separar el renombrado global de tags queda pendiente y no fue iniciado.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios.

Riesgos previos relevantes

- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y no fue modificado.
- Ningún riesgo nuevo de producto quedó abierto por 5.5.

Herramientas temporales restantes

- Ninguna creada por 5.5 debe permanecer al cerrar; applier/script ya se eliminaron y este finalizador se elimina en el commit de cierre.

Fallos encontrados y causa

- Run 34245897420: primera definición del applier inválida; GitHub no creó jobs. Fallo de tooling, sin cambios de producto.
- Run 34246236588: el mismo workflow inválido volvió a fallar al versionarse el script temporal; sin trabajo de producto.
- Run 34246285595: workflow simplificado, extracción y matriz completa PASS; publicó la implementación y retiró tooling temporal.
- Run 34246671614: primera definición del finalizador documental inválida; no creó jobs ni modificó documentos.

Veredicto

Terminada.

Papelera y restauración quedaron fuera de `App.tsx` conservando borrado individual/masivo, audio, intents offline, runtime, commits explícitos de borrado y la prohibición de doble publicación del índice al restaurar.

Siguiente tarea

5.6 — Separar el renombrado global de tags.

No iniciada.
```
'''
REGISTRO.write_text(registro + entry + "\n")

AGENT.write_text('''# BeatGaler — Agent State

Fecha de ejecución: 2026-09-08
Rama de trabajo obligatoria: `v0.9.0-test-noche`

## Estado actual

- Tarea trabajada: **5.5 — Separar papelera y restauración**
- Estado: **Terminada**
- Última tarea terminada: **5.5 — Separar papelera y restauración**
- SHA inicial de esta ejecución: `99ec3ad8f27eecad526623a7816971121e33c6ef`
- SHA final de implementación verificada: `c5b9843cd093a008a0adaa8a615327c060a7802c`
- Run de verificación principal: **34246285595 — SUCCESS**
- Comprobaciones pendientes para 5.5: **ninguna**

## Resultado verificado

- `useTrashActions` posee borrado individual, borrado masivo, exclusión de deletes simultáneos y restauración desde Settings.
- Se conservaron confirmaciones/avisos, liberación de audio, runtime e intents offline; los commits online mantienen `move-to-trash` y `bulk-remove`.
- Restore online siembra snapshots y no llama `commitSnapshot`, evitando una segunda publicación del índice ya realizada por la capa nativa.
- Run 34246285595 terminó PASS en typecheck, unit TS, component DOM, integration, regressions, build:web y build, además de `git diff --check` antes del commit.

## Pendientes concretos / fuera de alcance

- 5.6 — Separar el renombrado global de tags queda pendiente y no fue iniciado.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 5.5.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.
- No deben quedar herramientas temporales creadas por 5.5 en el árbol final.

## Siguiente tarea

- **5.6 — Separar el renombrado global de tags**
- Estado: **Pendiente**
- No iniciarla hasta la próxima ronda.
''')
