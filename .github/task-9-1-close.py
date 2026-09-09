from __future__ import annotations

import os
import subprocess
from pathlib import Path

IMPLEMENTATION_SHA = "f381d77a50280a4a1c19bbfbd7c717019ba9fd3b"
INITIAL_SHA = "8541ba633d7f0ab0b271b82014410b5998bd0c52"
BRANCH = "v0.9.0-test-noche"

roadmap_path = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
roadmap = roadmap_path.read_text()
old_task = "### [ ] 9.1 — Separar sesión y ajustes"
new_task = "### [x] 9.1 — Separar sesión y ajustes"
if roadmap.count(old_task) != 1:
    raise SystemExit(f"roadmap 9.1: expected one unchecked task, got {roadmap.count(old_task)}")
roadmap_path.write_text(roadmap.replace(old_task, new_task, 1))

registro_path = Path("migration/Registro-de-avance.md")
registro = registro_path.read_text()
if "### Registro — 9.1" in registro:
    raise SystemExit("Registro 9.1 already exists; refusing duplicate append")

entry = """### Registro — 9.1

```
Tarea: 9.1 — Separar sesión y ajustes
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 8541ba633d7f0ab0b271b82014410b5998bd0c52
- SHA de implementación validada: f381d77a50280a4a1c19bbfbd7c717019ba9fd3b
- Última tarea verificada: 8.3 — Separar recepción nativa

Cambio realizado

- Se creó `src/features/session/useSessionState.ts` como owner único del estado de ajustes, setup, conectividad y verificación cloud consumido por los flujos restantes.
- `connectionState` y `cloudSessionVerified` continúan siendo datos independientes; no se colapsaron en una sola señal.
- Se creó `src/features/session/useSessionActions.ts` para los cambios locales de preferencias y la acción de Sign out/desconexión.
- La desconexión conserva la limpieza previa: logout tolerante a fallo, release de audio, invalidación del revelado progresivo, limpieza de preparación de playback/artwork, beats revelados, verificación cloud, galería y selección; además actualiza los campos de cuenta conectada en settings.
- Se creó `src/features/session/useCustomCursor.ts` y se trasladó allí el efecto del cursor manteniendo el whitelist explícito de controles de edición de texto.
- `App.tsx` compone los nuevos owners y ya no posee esos estados/callbacks/efecto localmente.
- Startup, Reload, reconexión online/offline y SSE permanecen deliberadamente en `App.tsx`; corresponden a 9.2, 9.3 y 9.4 y no se adelantaron.

Adaptación de pruebas

- Se añadió `tests/component-dom/sessionState.test.tsx` para proteger independencia entre conectividad/verificación, cambios de preferencias, efecto del cursor y cleanup completo de Sign out.
- Se añadió `tests/integration/appSessionExtraction.test.ts` para proteger ownership y evitar adelantar startup/reconnect/SSE.
- `scripts/run-regressions.mjs` sigue verificando el mismo whitelist del cursor desde su nuevo owner `useCustomCursor.ts`; se cambió la ubicación inspeccionada, no el contrato.

Archivos de implementación/pruebas afectados

- scripts/run-regressions.mjs
- src/App.tsx
- src/features/session/useCustomCursor.ts
- src/features/session/useSessionActions.ts
- src/features/session/useSessionState.ts
- tests/component-dom/sessionState.test.tsx
- tests/integration/appSessionExtraction.test.ts

Comprobaciones ejecutadas

- GitHub Actions `Final Task 9.1 Validation 2`, run 34311448820 — SUCCESS.
- Artifact `migration-check-logs-task-9-1-34311448820` leído — `Migration checks: PASS`.
- Pruebas focalizadas `sessionState.test.tsx` + `appSessionExtraction.test.ts` — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- El workflow publicó el commit exacto validado `f381d77a50280a4a1c19bbfbd7c717019ba9fd3b`.
- Comparación neta `8541ba633d7f0ab0b271b82014410b5998bd0c52...f381d77a50280a4a1c19bbfbd7c717019ba9fd3b`: exactamente siete archivos de implementación/pruebas/regresión; el tooling temporal no permanece en el árbol validado.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente typecheck, unit TS, component DOM, integración, regresiones y ambos builds.
- Prueba física Desktop/Web interactiva no ejecutada ni inventada; no quedó como bloqueo porque los contratos modificados están cubiertos por pruebas DOM/integración/regresión y ambos builds.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: abrir Settings, alternar incomplete warnings y custom cursor, cambiar carpeta cuando aplique y ejecutar Sign out con audio/selección activos.
- Resultado esperado: Settings conserva la misma conducta visual/persistente; el cursor cambia igual que antes; Sign out limpia audio, galería, selección y verificación cloud sin mezclar conectividad de internet con verificación de sesión.

Pendientes / fuera de alcance

- 9.2 — Separar Reload queda pendiente y no fue iniciada.
- Startup inicial permanece para 9.3; listeners online/offline y SSE permanecen para 9.4.

Riesgos previos relevantes

- El fallo baseline del wrapper estático Mac relacionado con el Direct helper, documentado desde 8.1–8.3, no pertenece a 9.1 ni fue modificado por esta extracción.

Herramientas temporales restantes

- Ninguna debe permanecer en el árbol final. Los workflows/scripts temporales de 9.1 fueron retirados al publicar la implementación y el closer documental elimina su script y workflow dentro del propio commit.

Fallos encontrados y causa

- Run 34310977580: pruebas focalizadas y matriz pasaron, pero una condición temporal del workflow interpretó incorrectamente el resultado y bloqueó la publicación; fallo de tooling, sin commit de producto.
- Run 34311184722: la matriz detectó dos problemas reales de extracción: faltaba importar el tipo `ConnectionState` en `App.tsx` y el guard del cursor seguía buscando el whitelist físicamente en `App.tsx`. Se importó el tipo y se siguió el contrato hasta `useCustomCursor.ts` sin rebajar la assertion.
- Run 34311360174: el script temporal de corrección usó una coincidencia textual demasiado literal y abortó antes de tests; fallo de tooling, sin publicación de producto.
- Run 34311448820: focalizadas, diff check y toda la matriz quedaron verdes y se publicó `f381d77a50280a4a1c19bbfbd7c717019ba9fd3b`.
- Runs 34311757123 y 34311893799: dos closers documentales YAML fueron rechazados antes de crear jobs; no modificaron documentación ni producto y sus archivos fueron eliminados antes de este closer.

Veredicto

Terminada.

La sesión/ajustes quedó con un owner explícito; Settings, cursor y Sign out conservan comportamiento, y conectividad sigue separada de verificación cloud.

Siguiente tarea

9.2 — Separar Reload.

No iniciada.
```
"""
registro_path.write_text(registro.rstrip() + "\n\n" + entry + "\n")

subprocess.run(["git", "fetch", "origin", BRANCH], check=True)
observed = subprocess.check_output(["git", "rev-parse", f"origin/{BRANCH}"], text=True).strip()
expected_remote = os.environ.get("GITHUB_SHA")
if not expected_remote or observed != expected_remote:
    raise SystemExit(f"remote HEAD changed before agent-state write: {observed} != {expected_remote}")

run_id = os.environ.get("GITHUB_RUN_ID", "unknown")
agent_state = f"""# BeatGaler — Agent State

## Contexto

- Fecha de ejecución: 2026-09-08
- Rama de trabajo: `v0.9.0-test-noche`
- Tarea trabajada: `9.1 — Separar sesión y ajustes`
- Estado: `Terminada`
- Última tarea terminada: `9.1 — Separar sesión y ajustes`

## Base de esta ejecución

- SHA inicial: `{INITIAL_SHA}`
- SHA de implementación validada: `{IMPLEMENTATION_SHA}`
- HEAD remoto observado inmediatamente antes de la escritura final de agent-state: `{observed}`
- Run de implementación final: `34311448820` — `Final Task 9.1 Validation 2` — focalizadas, diff check, matriz completa y publicación del commit exacto correctas.
- Artifact final: `migration-check-logs-task-9-1-34311448820` — `Migration checks: PASS`.
- Run de cierre documental: `{run_id}` — actualiza solamente roadmap/Registro/agent-state y elimina su tooling temporal.
- El SHA final real de la ronda debe releerse desde GitHub después de la última escritura y no se intenta autorreferenciar aquí.

## Resultado verificado

- `src/features/session/useSessionState.ts` posee settings, setup, conectividad y verificación cloud; `connectionState` y `cloudSessionVerified` permanecen independientes.
- `src/features/session/useSessionActions.ts` posee los cambios de preferencias y Sign out, conservando limpieza de audio, presentación/revelado, galería, selección y verificación cloud.
- `src/features/session/useCustomCursor.ts` posee el efecto del cursor conservando el whitelist de edición de texto.
- `App.tsx` consume los nuevos owners; Reload, startup, reconnect online/offline y SSE permanecen para sus tareas posteriores.
- `tests/component-dom/sessionState.test.tsx` y `tests/integration/appSessionExtraction.test.ts` protegen los contratos de 9.1.
- `scripts/run-regressions.mjs` sigue verificando el cursor desde el nuevo owner sin relajar el contrato.
- Typecheck, unit TS, component DOM, integración, regresiones, build Web y build Desktop pasaron sobre el estado publicado como `{IMPLEMENTATION_SHA}`.

## Pendientes concretos

- `9.2 — Separar Reload`.

## Comprobaciones pendientes

- Ninguna necesaria para cerrar 9.1.
- Prueba física Desktop/Web no ejecutada ni inventada; no quedó como bloqueo porque los contratos afectados están cubiertos por focalizadas, matriz completa y ambos builds.

## Siguiente tarea

- `9.2 — Separar Reload`
- Estado: `Pendiente`
- No iniciar hasta la próxima ronda.
"""
Path("migration/BeatGaler-agent-state.md").write_text(agent_state)
