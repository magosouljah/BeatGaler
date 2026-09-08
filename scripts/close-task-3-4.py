from pathlib import Path

roadmap = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
text = roadmap.read_text(encoding="utf-8")
old = "### [ ] 3.4 — Separar selección y reordenamiento"
new = "### [x] 3.4 — Separar selección y reordenamiento"
if text.count(old) != 1:
    raise SystemExit(f"roadmap anchor count={text.count(old)}")
roadmap.write_text(text.replace(old, new, 1), encoding="utf-8")

state = Path("migration/BeatGaler-agent-state.md")
state.write_text("""# BeatGaler Agent State

## Seguridad de la ronda nocturna

- Rama exclusiva: `v0.9.0-test-noche`
- Prohibido modificar o avanzar `integration-v0.9.0-alpha.2`, `main` o ramas `app-tsx-*`.
- Prohibido merge, rebase, cherry-pick, fast-forward hacia otras ramas o PR de integración durante la prueba.
- Todos los commits y pushes de la ronda deben quedar únicamente en `v0.9.0-test-noche`.

## Estado operativo

- Tarea trabajada: `3.4 — Separar selección y reordenamiento`
- Estado: `Terminada`
- Última tarea terminada: `3.4 — Separar selección y reordenamiento`
- SHA inicial de esta ejecución: `811058e833071d41639993fa717c885eb1577cea`
- SHA final de implementación verificada: `811058e833071d41639993fa717c885eb1577cea`
- Pendientes concretos: ninguno de 3.4.
- Comprobaciones pendientes: ninguna necesaria para reabrir 3.4.
- Siguiente tarea: `4.1 — Separar la carga de portadas`
- Estado de la siguiente tarea: `Pendiente`
- Fecha de ejecución: `2026-09-08`

## Evidencia de cierre de 3.4

- Implementación: selección extraída a `src/features/selection/useBeatSelection.ts` y reordenamiento a `src/features/library/useLibraryReorder.ts`.
- GitHub Actions: `Temporary Task 3.4 Apply`, run `34211720605`, resultado `success`.
- Checks verdes: diff check, typecheck, unit TypeScript, component DOM, integration, regressions, build web y build.
- El fallo previo del run `34211385742` ocurrió en `Prepare verified commit`; todos los checks de código anteriores habían pasado y la corrida posterior corrigió la publicación sin cambiar el contrato funcional.

## Regla de actualización

Al cerrar cada ejecución:
- si la tarea queda `Terminada`, marcar solo su `[x]` en el roadmap, agregar su registro al final de `Registro-de-avance.md` y dejar aquí la siguiente tarea como `Pendiente`;
- si queda `En curso` o `Por verificar`, mantener esa misma tarea como tarea actual y registrar exactamente lo que falta;
- nunca iniciar una segunda tarea en la misma ejecución.
""", encoding="utf-8")

log = Path("migration/Registro-de-avance.md")
existing = log.read_text(encoding="utf-8")
marker = "### Registro — 3.4"
if marker in existing:
    raise SystemExit("Registro 3.4 already exists")
entry = r'''

### Registro — 3.4

```
Tarea: 3.4 — Separar selección y reordenamiento
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 811058e833071d41639993fa717c885eb1577cea
- Última tarea verificada: 3.3 — Separar búsqueda, filtros y etiquetas
- El pre-flight encontró implementación versionada de 3.4 ya publicada en el HEAD, mientras agent-state, roadmap y registro todavía la mostraban Pendiente. Se trató como recuperación de una ejecución interrumpida y no se repitió la implementación.

Cambio realizado

- La selección individual, Shift-range, Select All y limpieza de selección viven en `src/features/selection/useBeatSelection.ts`.
- El hook conserva el ancla de rango, reemplaza el rango anterior en Shift y reconcilia IDs seleccionados contra la biblioteca viva.
- El drag/reorder vive en `src/features/library/useLibraryReorder.ts`.
- Se conservó el delay/tolerance del PointerSensor, el cambio a orden manual fuera de rating y el límite que impide mover entre grupos con rating distinto.
- `App.tsx` quedó conectado a ambos hooks y dejó de poseer los estados/handlers extraídos.
- No se inició 4.1 ni se modificó ninguna otra rama.

Adaptación de pruebas

- `tests/component-dom/beatSelection.test.tsx` cubre toggle individual, rango Shift con ancla fija, Select All, reconciliación al filtrar/eliminar beats y limpieza final.
- `tests/integration/selectionReorderExtraction.test.ts` comprueba ownership fuera de App, wiring de selección y conservación de los límites del reorder por rating.
- Las guardas existentes no fueron desactivadas para obtener verde.

Archivos afectados por la implementación recuperada

- src/App.tsx
- src/features/selection/useBeatSelection.ts
- src/features/library/useLibraryReorder.ts
- tests/component-dom/beatSelection.test.tsx
- tests/integration/selectionReorderExtraction.test.ts

Archivos afectados por este cierre

- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary Task 3.4 Apply`, run 34211720605 — SUCCESS.
- npm ci — OK.
- git diff --check — OK.
- npm run test:typecheck — OK.
- npm run test:unit:ts — OK.
- npm run test:component:dom — OK.
- npm run test:integration — OK.
- npm run test:regressions — OK.
- npm run build:web — OK.
- npm run build — OK.

Comprobaciones no ejecutadas

- npm run check — no requerido para esta extracción; el plan reserva el wrapper completo para hitos/cierre y sus checks de extracción se ejecutaron individualmente.
- E2E import/download/recovery — no aplican a selección/reordenamiento.
- Pruebas nativas físicas Windows/macOS — no necesarias para cerrar esta extracción de ownership, sin cambios en adapters ni comandos nativos.

Prueba manual

- No requerida como bloqueo de cierre. La semántica específica de selección Shift, filtrado/reconciliación y límites de reorder quedó cubierta por pruebas directas y de integración.

Pendientes / fuera de alcance

- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y no fue modificado.
- No se inició ninguna extracción de artwork/playback.

Riesgos previos relevantes

- Ninguno nuevo causado por 3.4.

Herramientas temporales restantes

- Ninguna al cerrar: los workflows y scripts temporales de esta ronda se eliminan del árbol final.

Fallos encontrados y causa

- Run 34211385742 terminó en failure únicamente en `Prepare verified commit`; todos los checks de código y builds anteriores habían pasado. Run 34211720605 corrigió la publicación y terminó en success.
- Run 34213532632 no creó jobs porque el primer workflow temporal de cierre tenía YAML inválido; no ejecutó comandos ni modificó código/documentación.
- Run 34213964984 falló antes de editar documentos porque el payload base64 del script temporal quedó truncado (`base64: invalid input`).
- Run 34214167203 aplicó las ediciones solo en el runner pero `git diff --check` rechazó una línea en blanco extra al EOF de `Registro-de-avance.md`; no hubo commit ni push de esas ediciones.

Veredicto

Terminada.

Seleccionar, deseleccionar, usar Shift, reconciliar selección con cambios de biblioteca y reordenar conservan los contratos comprobados, incluido el límite entre ratings distintos.

Siguiente tarea

4.1 — Separar la carga de portadas.

No iniciada.
```
'''
log.write_text(existing.rstrip() + entry.rstrip() + "\n", encoding="utf-8")