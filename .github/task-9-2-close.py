from pathlib import Path
import os

ROADMAP = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
REGISTRO = Path("migration/Registro-de-avance.md")
AGENT_STATE = Path("migration/BeatGaler-agent-state.md")

IMPLEMENTATION_SHA = "ef31e40653c82cbde9cf59b1d541dfd33e7829e8"
INITIAL_SHA = "9292213dcdfa45e7424108e3aa861e1ab7eeef53"
RUN_ID = os.environ.get("GITHUB_RUN_ID", "unknown")
PRE_CLOSE_HEAD = os.environ["PRE_CLOSE_HEAD"]

roadmap_text = ROADMAP.read_text()
old = "### [ ] 9.2 — Separar Reload"
new = "### [x] 9.2 — Separar Reload"
if old in roadmap_text:
    if roadmap_text.count(old) != 1:
        raise SystemExit(f"Expected one pending 9.2 checkbox, found {roadmap_text.count(old)}")
    roadmap_text = roadmap_text.replace(old, new, 1)
elif new not in roadmap_text:
    raise SystemExit("Could not find task 9.2 checkbox")
ROADMAP.write_text(roadmap_text)

registro_text = REGISTRO.read_text()
if "### Registro — 9.2" in registro_text:
    raise SystemExit("Registro 9.2 already exists; refusing duplicate append")

entry = f'''### Registro — 9.2

```
Tarea: 9.2 — Separar Reload
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: {INITIAL_SHA}
- SHA de implementación validada: {IMPLEMENTATION_SHA}
- Última tarea verificada: 9.1 — Separar sesión y ajustes

Cambio realizado

- Se creó `src/features/library/useLibraryReload.ts` como owner de la recarga manual, sus reintentos y la recepción de `beatgaler:deferred-library-reload`.
- `App.tsx` dejó de poseer `libraryRefreshing`, el callback completo de Reload y el listener de recarga diferida; conserva el wiring hacia `useLibraryReload` y el gesto manual que limpia `clearUploadPreviewCache()` antes de recargar.
- Reload conserva el feedback visual mínimo de 320 ms.
- Reload consulta primero `deferLibraryReloadIfUploading()`; la cola cloud conserva la actividad/pending marker y emite la recarga diferida únicamente después de drenar uploads.
- La ruta cloud conserva hasta cuatro intentos de autoridad con backoff `450 * attempt`, reparación tolerante de referencias stale y restauración autoritativa.
- Si la autoridad falla tras los reintentos, la conexión pasa a `poor`, la sesión cloud queda no verificada y la galería visible se conserva; autoridad desconocida no se interpreta como biblioteca vacía.
- La ruta offline conserva la biblioteca visible cuando el navegador está offline y ya existe contenido cargado; sin conexión cloud configurada sigue cargando la biblioteca offline.
- No se inició 9.3; startup inicial permanece fuera del alcance de esta ronda.

Adaptación de pruebas

- Se añadió `tests/component-dom/libraryReload.test.tsx` para cubrir Reload autoritativo y feedback, defer durante upload + evento tras drain, y cuatro fallos de autoridad preservando la galería.
- Se añadió `tests/integration/appLibraryReloadExtraction.test.ts` para proteger el nuevo ownership y los contratos de defer/retry/feedback/galería.
- `tests/integration/appMigrationCharacterization.test.ts` y `tests/integration/appCloudUploadQueueExtraction.test.ts` siguen ahora el contrato hasta `useLibraryReload.ts` sin relajar la coordinación de la cola.
- `tests/component-dom/startupRevealArchitecture.test.ts` dejó de exigir físicamente en `App.tsx` el reveal que Reload sigue ejecutando desde su nuevo owner.

Archivos de implementación/pruebas afectados

- src/App.tsx
- src/features/library/useLibraryReload.ts
- tests/component-dom/libraryReload.test.tsx
- tests/component-dom/startupRevealArchitecture.test.ts
- tests/integration/appCloudUploadQueueExtraction.test.ts
- tests/integration/appLibraryReloadExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts

Comprobaciones ejecutadas

- GitHub Actions `Task 9.2 Apply`, run 34314514114 — SUCCESS.
- Artifact `migration-check-logs-task-9-2-34314514114` — `Migration checks: PASS`.
- Focalizadas de 9.2: 5 archivos / 28 tests — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- El workflow publicó el estado exacto validado como `{IMPLEMENTATION_SHA}` y eliminó su tooling temporal del árbol de implementación.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente los checks aplicables.
- Prueba física Desktop/Web interactiva no ejecutada ni inventada; no quedó como bloqueo porque uploads activos/sin uploads, fallo de autoridad, feedback visual y ownership están cubiertos por pruebas focalizadas/component DOM/integración y ambos builds.

Prueba manual

- No ejecutada ni inventada.
- No es necesaria para cerrar 9.2 según la evidencia automatizada disponible.
- Sugerida: iniciar un upload y pulsar Reload; comprobar que el botón conserva feedback, la recarga queda pendiente y se ejecuta al drenar la cola. Repetir sin upload y simular fallo temporal cloud.
- Resultado esperado: con upload activo se difiere; sin upload se recarga inmediatamente; con fallo de autoridad la galería visible no desaparece.

Pendientes / fuera de alcance

- 9.3 — Separar el arranque inicial queda pendiente y no fue iniciada.
- Reconexión online/offline y SSE continúan para 9.4; aparición progresiva general continúa para 9.5.

Riesgos previos relevantes

- El fallo baseline histórico del wrapper estático Mac relacionado con el Direct helper pertenece a tareas anteriores y no fue modificado por 9.2.
- Las focalizadas finales emitieron warnings de React `act(...)` sin fallos de assertions; las 28 pruebas focalizadas y la suite component DOM completa terminaron en PASS.

Herramientas temporales restantes

- Ninguna permanece tras este cierre. El tooling temporal de implementación fue retirado al publicar `{IMPLEMENTATION_SHA}` y el closer elimina su script/workflow en el mismo commit documental.

Fallos encontrados y causa

- Run 34313664276 no creó jobs por YAML temporal inválido; no ejecutó ni publicó producto.
- Run 34313709263 abortó porque el aplicador temporal asumía incorrectamente que `repairStaleCloudLibraryRefs` debía desaparecer por completo de `App.tsx`; se conservó su uso legítimo ajeno a Reload.
- Run 34313796208 detectó tres timeouts en la prueba nueva por fake timers mal coordinados y una prueba existente acoplada a que reveal vivía físicamente en `App.tsx`; se corrigieron las pruebas para seguir comportamiento/ownership sin modificar la semántica de Reload.
- Run 34314180802 no creó jobs por otro detalle YAML temporal; no modificó producto.
- Run 34314223337 dejó focalizadas, diff check y `Migration checks: PASS`, pero el guard de publicación omitía archivos nuevos untracked y bloqueó el commit validado.
- Run 34314514114 corrigió exclusivamente ese guard; focalizadas, diff check, toda la matriz y publicación terminaron en SUCCESS, produciendo `{IMPLEMENTATION_SHA}`.
- Run 34314789957 fue rechazado antes de crear jobs por la definición YAML del primer closer documental; no modificó documentación ni producto.

Veredicto

Terminada.

Reload quedó con un owner explícito fuera de `App.tsx`, conservando defer por uploads, reintentos, feedback visual y la regla de no vaciar la galería ante autoridad desconocida.

Siguiente tarea

9.3 — Separar el arranque inicial.

No iniciada.
```
'''
separator = "" if registro_text.endswith("\n\n") else ("\n" if registro_text.endswith("\n") else "\n\n")
REGISTRO.write_text(registro_text + separator + entry)

agent_state = f'''# BeatGaler — Agent State

## Contexto

- Fecha de ejecución: 2026-09-08
- Rama de trabajo: `v0.9.0-test-noche`
- Tarea trabajada: `9.2 — Separar Reload`
- Estado: `Terminada`
- Última tarea terminada: `9.2 — Separar Reload`

## Base de esta ejecución

- SHA inicial: `{INITIAL_SHA}`
- SHA de implementación validada: `{IMPLEMENTATION_SHA}`
- HEAD remoto observado inmediatamente antes del cierre documental: `{PRE_CLOSE_HEAD}`
- Run de implementación final: `34314514114` — `Task 9.2 Apply` — focalizadas, diff check, matriz completa y publicación del commit exacto correctas.
- Artifact final: `migration-check-logs-task-9-2-34314514114` — `Migration checks: PASS`.
- Run de cierre documental: `{RUN_ID}` — actualiza roadmap/Registro/agent-state y elimina su tooling temporal.
- El SHA final real de la ronda se relee desde GitHub después de esta escritura y no se autorreferencia aquí.

## Resultado verificado

- `src/features/library/useLibraryReload.ts` posee Reload manual, `libraryRefreshing`, los reintentos de autoridad y la recepción de `beatgaler:deferred-library-reload`.
- La cola cloud sigue siendo owner de la actividad de uploads y del pending marker; Reload se difiere mientras hay actividad y se reintenta al drenar la cola.
- Se conservan feedback mínimo de 320 ms, cuatro intentos de autoridad con backoff y reparación tolerante de referencias stale.
- Un fallo de autoridad conserva la galería visible, marca conexión `poor` y deja la sesión cloud no verificada; autoridad desconocida no equivale a biblioteca vacía.
- `App.tsx` consume el nuevo owner y conserva el gesto manual de limpiar `clearUploadPreviewCache()` antes de Reload.
- Las pruebas focalizadas cubren Reload con/sin upload activo, evento diferido, feedback y preservación de galería ante cuatro fallos de autoridad.
- Typecheck, unit TS, component DOM, integración, regresiones, build Web y build Desktop pasaron sobre el estado publicado como `{IMPLEMENTATION_SHA}`.

## Pendientes concretos

- `9.3 — Separar el arranque inicial`.

## Comprobaciones pendientes

- Ninguna necesaria para cerrar 9.2.
- Prueba física Desktop/Web no ejecutada ni inventada; no quedó como bloqueo porque los criterios de 9.2 están cubiertos por focalizadas, component DOM, integración y ambos builds.

## Siguiente tarea

- `9.3 — Separar el arranque inicial`
- Estado: `Pendiente`
- No iniciar hasta la próxima ronda.
'''
AGENT_STATE.write_text(agent_state)
