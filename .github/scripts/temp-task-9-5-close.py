from pathlib import Path
import os
import sys


def apply_candidate() -> None:
    workflow = Path('.github/workflows/temp-task-9-5-apply.yml').read_text().splitlines()
    start = next(i for i, line in enumerate(workflow) if "python3 <<'PY'" in line) + 1
    end = next(i for i in range(start, len(workflow)) if workflow[i].strip() == 'PY')
    code = '\n'.join(line[10:] if line.startswith('          ') else line for line in workflow[start:end]) + '\n'
    exec(compile(code, '<task-9-5-apply>', 'exec'), {'__name__': '__main__'})

    app_path = Path('src/App.tsx')
    app = app_path.read_text()
    anchor = 'import { useLibraryReveal } from "./features/startup/useLibraryReveal";\n'
    assert anchor in app
    app_path.write_text(app.replace(anchor, anchor + 'import { dismissBeatGalerStartupLoader } from "./features/startup/startupLoader";\n', 1))

    component_path = Path('tests/component-dom/startupRevealArchitecture.test.ts')
    component = component_path.read_text()
    decl = 'const app = readFileSync("src/App.tsx", "utf8");\n'
    assert decl in component and 'libraryRevealOwner' not in component
    component = component.replace(decl, decl + 'const libraryRevealOwner = readFileSync("src/features/startup/useLibraryReveal.ts", "utf8");\n', 1)
    old = '    expect(app).toContain("title + artwork are enough to show a beat");'
    assert old in component
    component_path.write_text(component.replace(old, '    expect(libraryRevealOwner).toContain("Authority pass: title + artwork reveal a card. Audio remains a later viewport warmup.");', 1))

    integration_path = Path('tests/integration/issue97RuntimeWebFollowup.test.ts')
    integration = integration_path.read_text()
    old_block = '''  it("does not let Web card warming queue native cooking ahead of Play", () => {\n    const app = source("src/App.tsx");\n    const playbackController = source("src/features/playback/usePlaybackController.ts");\n    expect(playbackController).toContain('if (!platform.capabilities.playbackCache || !cloudSessionVerified || connectionState !== "online") return;');\n    expect(app).toContain("Math.min(isTauriAvailable ? 6 : 1, queue.length)");\n  });'''
    new_block = '''  it("does not let Web card warming queue native cooking ahead of Play", () => {\n    const app = source("src/App.tsx");\n    const revealOwner = source("src/features/startup/useLibraryReveal.ts");\n    const playbackController = source("src/features/playback/usePlaybackController.ts");\n    expect(playbackController).toContain('if (!platform.capabilities.playbackCache || !cloudSessionVerified || connectionState !== "online") return;');\n    expect(app).toContain("nativeParallelism: isTauriAvailable ? 6 : 1");\n    expect(revealOwner).toContain("Math.min(nativeParallelism, queue.length)");\n  });'''
    assert old_block in integration
    integration_path.write_text(integration.replace(old_block, new_block, 1))


def update_docs(impl: str) -> None:
    roadmap_path = Path('migration/BeatGaler-roadmap-para-trabajar-con-IAs.md')
    roadmap = roadmap_path.read_text()
    old = '### [ ] 9.5 — Separar la aparición de tarjetas'
    assert old in roadmap
    roadmap_path.write_text(roadmap.replace(old, '### [x] 9.5 — Separar la aparición de tarjetas', 1))

    state = f'''# BeatGaler — Agent State

## Contexto

- Fecha de ejecución: 2026-09-09
- Rama de trabajo: `v0.9.0-test-noche`
- Tarea trabajada: `9.5 — Separar la aparición de tarjetas`
- Estado: `Terminada`
- Última tarea terminada: `9.5 — Separar la aparición de tarjetas`

## Base de esta ejecución

- SHA inicial: `aa2f88cf7ea06a0a84dfb13d5f172c6bd6ba3f2b`
- SHA de implementación validada: `{impl}`
- El SHA final real de la ronda se relee desde GitHub después de esta escritura y no se autorreferencia aquí.

## Resultado verificado

- `src/features/startup/useLibraryReveal.ts` posee el revelado cache-first, el gate de autoridad y el revelado progresivo de artwork.
- `src/features/startup/startupLoader.ts` posee la retirada del indicador de arranque.
- `App.tsx` compone `useLibraryReveal` y conserva únicamente las conexiones necesarias con carga, sesión, artwork y presentación.
- La aparición de tarjetas sigue gobernada por título/artwork y no espera preparación de audio.
- El arranque offline sigue validando `loadOfflineLibrary()` antes de exponer la biblioteca.
- Las guardas estructurales que antes buscaban esta responsabilidad dentro de `App.tsx` ahora verifican al dueño extraído.
- Pasaron la caracterización enfocada de 9.5, typecheck, unit TS, component DOM, integración, regresiones, build Web y build Desktop frontend sobre el árbol ejecutable de `{impl}`.
- `e2e:core` no existe y no es un gate del plan. Los E2E adicionales están reservados por el plan para hitos de import/drop y para el cierre global.

## Pendientes concretos

- `10.1 — Extraer la estructura visual restante`.
- `10.2 — Dejar la composición mínima`.
- `10.3 — Retirar restos y conexiones temporales`.
- `10.4 — Comprobar el resultado completo`.

## Comprobaciones pendientes

- Ninguna necesaria para cerrar 9.5.
- Los E2E y la validación amplia de cierre corresponden a 10.4; no se adelantaron ni se inventaron en esta tarea.

## Siguiente tarea

- `10.1 — Extraer la estructura visual restante`
- Estado: `Pendiente`
- No iniciar hasta la próxima ronda.
'''
    Path('migration/BeatGaler-agent-state.md').write_text(state)

    register_path = Path('migration/Registro-de-avance.md')
    register = register_path.read_text().rstrip()
    entry = f'''

## 2026-09-09 — Tarea 9.5 — Separar la aparición de tarjetas

- **Estado:** Terminada.
- **SHA inicial de la ronda:** `aa2f88cf7ea06a0a84dfb13d5f172c6bd6ba3f2b`.
- **SHA de implementación validada:** `{impl}`.
- **Cambio realizado:** se extrajeron el revelado cache-first/progresivo y la retirada del loader desde `App.tsx` hacia `src/features/startup/useLibraryReveal.ts` y `startupLoader.ts`, conservando el gate de autoridad, el orden del arranque offline y la independencia entre aparición de tarjetas y preparación de audio.
- **Pruebas adaptadas:** las guardas de `startupRevealArchitecture` e `issue97RuntimeWebFollowup` verifican ahora al dueño real de la responsabilidad; se añadió caracterización enfocada `appLibraryRevealExtraction.test.ts`.
- **Comprobaciones:** caracterización enfocada 9.5, `npm run test:typecheck`, `npm run test:unit:ts`, `npm run test:component:dom`, `npm run test:integration`, `npm run test:regressions`, `npm run build:web` y `npm run build`, todas verdes antes del commit de implementación.
- **E2E:** el intento previo `npm run e2e:core` era inválido porque ese script no existe. El plan no exige un E2E adicional para 9.5; los E2E ampliados corresponden a import/drop y al cierre.
- **Limpieza:** se retiraron workflows, helper y logs temporales usados para diagnosticar 9.5.
- **Siguiente tarea:** `10.1 — Extraer la estructura visual restante`.
'''
    register_path.write_text(register + entry + '\n')


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'apply':
        apply_candidate()
    elif action == 'docs':
        update_docs(sys.argv[2])
    else:
        raise SystemExit(f'Unknown action: {action}')
