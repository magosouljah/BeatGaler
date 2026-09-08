from pathlib import Path

INITIAL_SHA = "ef21985dd5c027dfadbb143a8c2a5a413fef5347"
IMPLEMENTATION_SHA = "3b437aee8454b392e832b8bce65485be731e045b"
SUCCESS_RUN = "34243725534"

roadmap_path = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
roadmap = roadmap_path.read_text()
old_task = "### [ ] 5.4 — Separar Available Offline"
new_task = "### [x] 5.4 — Separar Available Offline"
if new_task not in roadmap:
    if roadmap.count(old_task) != 1:
        raise SystemExit("Expected exactly one pending 5.4 roadmap entry")
    roadmap = roadmap.replace(old_task, new_task, 1)
roadmap_path.write_text(roadmap)

registro_path = Path("migration/Registro-de-avance.md")
registro = registro_path.read_text()
header = "### Registro — 5.4"
if header not in registro:
    entry = f'''\n\n### Registro — 5.4\n\n```\nTarea: 5.4 — Separar Available Offline\nEstado: Terminada\nFecha: 2026-09-08\n\nBase\n\n- Rama: v0.9.0-test-noche\n- SHA inicial de esta ejecución: {INITIAL_SHA}\n- Última tarea verificada: 5.3 — Separar proyectos\n\nCambio realizado\n\n- Se creó `src/features/offline/useOfflineAvailability.ts` como owner de creación y eliminación de paquetes Available Offline, incluido `offlineBusyIds` y el flujo completo de `handleToggleOffline`.\n- `App.tsx` dejó de llamar directamente `makeBeatAvailableOffline` y `removeBeatOfflineAvailability`; ahora compone `useOfflineAvailability` con conexiones explícitas a biblioteca, runtime y playback.\n- Se conservó la separación entre paquete durable y caché temporal: al quitar disponibilidad se libera el audio activo cuando corresponde y se llama `invalidatePlaybackPreparation(beat.id)` antes de borrar el paquete durable.\n- Online, quitar Available Offline conserva metadata/artwork vivos, limpia únicamente rutas locales y vuelve a preparar la ruta cloud; offline, el beat se elimina de la biblioteca visible tras retirar su único paquete durable.\n- Crear el paquete conserva `DOWNLOAD_STARTED`/`DOWNLOAD_SUCCEEDED`/`DOWNLOAD_FAILED`, `SET_OFFLINE_AVAILABLE`, artwork ya cargado y el sonido de finalización.\n- No se modificaron los comandos nativos que almacenan los paquetes bajo almacenamiento durable ni `loadOfflineLibrary`; esta tarea solo cambió ownership/composición React.\n- No se inició 5.5.\n\nAdaptación de pruebas\n\n- Se añadió `tests/integration/appOfflineAvailabilityExtraction.test.ts` para caracterizar ownership, creación/eliminación durable, estados runtime, invalidación previa y resultados online/offline.\n- `tests/integration/appPlaybackExtraction.test.ts` ahora busca el call site de invalidación en el nuevo owner Offline y sigue exigiendo que la implementación de invalidación pertenezca al playback controller.\n- `scripts/run-regressions.mjs` se adaptó para seguir `SET_OFFLINE_AVAILABLE` y el bloque de retirada en `useOfflineAvailability.ts`; conserva las mismas exigencias de Fast Play, warm promises, limpieza de rutas locales y persistencia nativa.\n- No se relajó ningún contrato para hacer pasar los checks.\n\nArchivos afectados\n\n- src/App.tsx\n- src/features/offline/useOfflineAvailability.ts\n- tests/integration/appOfflineAvailabilityExtraction.test.ts\n- tests/integration/appPlaybackExtraction.test.ts\n- scripts/run-regressions.mjs\n- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md\n- migration/Registro-de-avance.md\n- migration/BeatGaler-agent-state.md\n\nComprobaciones ejecutadas\n\n- GitHub Actions `Task 5.4 Apply`, run {SUCCESS_RUN} — SUCCESS.\n- Artifact `migration-check-logs-task-5-4-{SUCCESS_RUN}-1`, `summary.txt` leído: PASS en todos los checks.\n- `git diff --check` — PASS.\n- `npm run test:typecheck` — PASS.\n- `npm run test:unit:ts` — PASS.\n- `npm run test:component:dom` — PASS.\n- `npm run test:integration` — PASS.\n- `npm run test:regressions` — PASS.\n- `npm run build:web` — PASS.\n- `npm run build` — PASS.\n- SHA de implementación verificada: {IMPLEMENTATION_SHA}.\n\nComprobaciones no ejecutadas\n\n- `npm run check` — no necesario; la matriz de migración ejecutó individualmente los checks aplicables y quedó completamente verde.\n- E2E completos de import/upload/download — fuera del alcance de esta extracción de ownership Offline.\n- Prueba física Desktop Windows/macOS con reinicio sin red — no disponible en GitHub Actions. No se considera bloqueo porque la implementación nativa durable, `offline_beats`, `loadOfflineLibrary` y la precedencia de paquetes Offline no cambiaron; sus invariantes existentes permanecen protegidas por regressions y ambos builds.\n\nPrueba manual\n\n- No ejecutada ni inventada.\n- Desktop: marcar un beat Available Offline, cerrar completamente la aplicación, cortar la red, reabrir y reproducir/abrir los assets incluidos; después reconectar, quitar Available Offline y comprobar que el beat sigue online sin rutas locales obsoletas.\n- Resultado esperado: el paquete sobrevive al reinicio sin red; al retirarlo online se conserva el beat cloud y al retirarlo estando offline desaparece de la biblioteca Offline actual.\n\nPendientes / fuera de alcance\n\n- 5.5 — Separar papelera y restauración queda pendiente y no fue iniciada.\n- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y sin cambios.\n\nRiesgos previos relevantes\n\n- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y no fue modificado.\n- Ningún riesgo nuevo de producto quedó abierto por 5.4.\n\nHerramientas temporales restantes\n\n- Ninguna creada por 5.4 debe permanecer al cerrar; el workflow/script de aplicación ya fueron eliminados y el finalizador se elimina en el commit de cierre.\n\nFallos encontrados y causa\n\n- Run 34242040393: YAML inválido antes de crear jobs; fallo de tooling, sin cambios de producto.\n- Run 34242602495: el payload base64 del applier temporal estaba corrupto y falló antes de los checks; fallo de tooling, sin commit de producto.\n- Run 34242903767: `summary.txt` mostró integration y regressions FAIL. El test nuevo usaba una ruta incompatible con el modo Vitest y guards existentes estaban acoplados a que el call site Offline permaneciera físicamente en App. Se clasificó como prueba nueva incorrecta + pruebas existentes acopladas a implementación interna legítimamente movida.\n- Run 34243249623: YAML inválido en el retry, sin jobs ni cambios de producto.\n- Run 34243311415: tras la primera adaptación quedaron typecheck/unit/DOM/integration/builds PASS y solo regressions FAIL porque un segundo guard de retirada Offline todavía inspeccionaba `App.tsx`; se trasladó al nuevo owner manteniendo el contrato.\n- Run {SUCCESS_RUN}: matriz completa y `git diff --check` PASS; commit de implementación publicado.\n\nVeredicto\n\nTerminada.\n\nAvailable Offline quedó fuera de App conservando paquetes durables, runtime, invalidación de Fast Play antes de borrar, y la diferencia observable entre retirada online y offline.\n\nSiguiente tarea\n\n5.5 — Separar papelera y restauración.\n\nNo iniciada.\n```\n'''
    registro = registro.rstrip() + entry + "\n"
    registro_path.write_text(registro)

agent_state = f'''# BeatGaler — Agent State

Fecha de ejecución: 2026-09-08
Rama de trabajo obligatoria: `v0.9.0-test-noche`

## Estado actual

- Tarea trabajada: **5.4 — Separar Available Offline**
- Estado: **Terminada**
- Última tarea terminada: **5.4 — Separar Available Offline**
- SHA inicial de esta ejecución: `{INITIAL_SHA}`
- SHA final de implementación verificada: `{IMPLEMENTATION_SHA}`
- Run de verificación principal: **{SUCCESS_RUN} — SUCCESS**
- Comprobaciones pendientes para 5.4: **ninguna**

## Resultado verificado

- `useOfflineAvailability` posee creación/eliminación del paquete durable, busy state y transiciones runtime.
- Quitar disponibilidad invalida Fast Play antes de borrar el paquete; online conserva metadata y limpia rutas locales, offline retira el beat de la biblioteca visible.
- `summary.txt` del artifact `migration-check-logs-task-5-4-{SUCCESS_RUN}-1` confirma PASS en typecheck, unit TS, component DOM, integration, regressions, build:web y build.
- La capa nativa durable y `loadOfflineLibrary` no fueron modificadas por esta extracción.

## Pendientes concretos / fuera de alcance

- 5.5 — Separar papelera y restauración queda pendiente y no fue iniciada.
- Riesgo previo de `handleRemoveBulk` con snapshots capturados: permanece sin cambios y fuera del alcance de 5.4.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.
- No deben quedar herramientas temporales creadas por 5.4 en el árbol final.

## Siguiente tarea

- **5.5 — Separar papelera y restauración**
- Estado: **Pendiente**
- No iniciarla hasta la próxima ronda.
'''
Path("migration/BeatGaler-agent-state.md").write_text(agent_state)
