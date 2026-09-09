from pathlib import Path

IMPL = "869b47565d794fcdeedff13340d0f57bf7545424"
INITIAL = "28a518c7db4a9e624fd8c66e1d511420b994c5dd"

roadmap_path = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
roadmap = roadmap_path.read_text()
old = "### [ ] 10.1 — Extraer la estructura visual restante"
assert old in roadmap
roadmap_path.write_text(roadmap.replace(old, "### [x] 10.1 — Extraer la estructura visual restante", 1))

state = f'''# BeatGaler — Agent State

## Contexto

- Fecha de ejecución: 2026-09-09
- Rama de trabajo: `v0.9.0-test-noche`
- Tarea trabajada: `10.1 — Extraer la estructura visual restante`
- Estado: `Terminada`
- Última tarea terminada: `10.1 — Extraer la estructura visual restante`

## Base de esta ejecución

- SHA inicial: `{INITIAL}`
- SHA de implementación validada: `{IMPL}`
- El SHA final real de la ronda se relee desde GitHub después de esta escritura y no se autorreferencia aquí.

## Resultado verificado

- `src/app/AppShell.tsx` posee la estructura visual restante: header, galería, avisos, selección, diálogos y player, manteniendo el montaje permanente de tareas de fondo.
- `src/app/useAppShortcuts.ts` posee los atajos globales de teclado extraídos de `App.tsx`.
- `src/features/publishing/usePublishingActions.ts` posee la apertura individual y bulk de publishing/YouTube.
- `App.tsx` conserva la composición y conexiones necesarias, pero ya no contiene los grandes bloques JSX movidos en 10.1.
- Las guardas estructurales afectadas verifican ahora el dueño real en `AppShell` sin relajar contratos de interacción, Offline, Trash, playback ni nube.
- Pasaron caracterización enfocada 10.1, `test:typecheck`, `test:unit:ts`, `test:component:dom`, `test:integration`, `test:regressions`, `build:web` y `build` sobre `{IMPL}`.

## Pendientes concretos

- `10.2 — Dejar la composición mínima`.
- `10.3 — Retirar restos y conexiones temporales`.
- `10.4 — Comprobar el resultado completo`.

## Comprobaciones pendientes

- Ninguna necesaria para cerrar 10.1.
- La validación final completa y los E2E de cierre corresponden a 10.4.

## Siguiente tarea

- `10.2 — Dejar la composición mínima`
- Estado: `Pendiente`
- No iniciar hasta la próxima ronda.
'''
Path("migration/BeatGaler-agent-state.md").write_text(state)

register_path = Path("migration/Registro-de-avance.md")
register = register_path.read_text().rstrip()
entry = f'''

## 2026-09-09 — Tarea 10.1 — Extraer la estructura visual restante

- **Estado:** Terminada.
- **SHA inicial de la ronda:** `{INITIAL}`.
- **SHA de implementación validada:** `{IMPL}`.
- **Cambio realizado:** se extrajo la estructura visual restante de `App.tsx` hacia `src/app/AppShell.tsx`; los atajos globales pasaron a `src/app/useAppShortcuts.ts` y la apertura individual/bulk de publishing quedó en `src/features/publishing/usePublishingActions.ts`.
- **Contratos conservados:** DOM efectivo, keys, portales, teclado, montaje permanente de tareas de fondo, gates de interacción/Offline, Trash, playback y rutas de publishing.
- **Pruebas adaptadas:** las guardas que dependían de JSX literal en `App.tsx` verifican ahora `AppShell` como dueño real; se mantuvo `appShellExtraction.test.ts`.
- **Comprobaciones:** caracterización enfocada 10.1, `npm run test:typecheck`, `npm run test:unit:ts`, `npm run test:component:dom`, `npm run test:integration`, `npm run test:regressions`, `npm run build:web` y `npm run build`, todas verdes sobre `{IMPL}`.
- **Limpieza:** se retiraron workflow y scripts temporales usados para aplicar, corregir y validar 10.1.
- **Siguiente tarea:** `10.2 — Dejar la composición mínima`.
'''
register_path.write_text(register + entry + "\n")
