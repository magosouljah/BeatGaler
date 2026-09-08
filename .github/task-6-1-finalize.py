from pathlib import Path

roadmap_path = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
roadmap = roadmap_path.read_text()
old_task = "### [ ] 6.1 — Separar las descargas de exportación"
new_task = "### [x] 6.1 — Separar las descargas de exportación"
if roadmap.count(old_task) != 1:
    raise SystemExit("Expected exactly one unchecked 6.1 roadmap entry")
if new_task in roadmap:
    raise SystemExit("6.1 is already checked in the roadmap")
roadmap_path.write_text(roadmap.replace(old_task, new_task, 1))

register_path = Path("migration/Registro-de-avance.md")
register = register_path.read_text()
if "### Registro — 6.1" in register:
    raise SystemExit("Registro 6.1 already exists")
entry = r'''

### Registro — 6.1

```
Tarea: 6.1 — Separar las descargas de exportación
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 58371aa0c291d18cf03b81b6a2adb6ed8c27ca31
- Última tarea verificada: 5.6 — Separar el renombrado global de tags

Cambio realizado

- Se creó `src/features/downloads/useBeatDownloads.ts` como owner de la apertura/cierre de Cloud Files, selección de destino, arranque de exportaciones, seguimiento por `taskId`, avisos de progreso/éxito/error y listener de resultados de descargas Desktop.
- `App.tsx` dejó de poseer directamente `handleGetCloudFile`, el listener `beatgaler-download-event`, el estado del modal y el seguimiento de la descarga; ahora compone `useBeatDownloads`.
- Desktop conserva MP3/WAV/PROJECT/ALL, nombres de audio con `[BPM Key]`, selección nativa de archivo/carpeta y `startBackgroundDownload`.
- Cancelar el selector de destino retorna antes de `DOWNLOAD_STARTED` y antes de iniciar el worker nativo, por lo que no crea una descarga ni reclama estado runtime.
- El listener y `trackedDownloadsRef` viven en el hook montado por la aplicación, no en el modal; cerrar Cloud Files solo cierra la UI y no elimina una tarea iniciada.
- La finalización/error se atribuye únicamente a `taskId` iniciados por este owner y no marca como descargado un beat distinto si el modal cambió o se cerró.
- Web reutiliza `platform.downloads.start(beat, kind)` y su promesa `completed`, incluida la cancelación del picker como no-op; no usa el worker Tauri.
- `CloudFilesModal` conserva disponibilidad MP3/WAV/PROJECT usando también los assets autoritativos de Web.
- Los guards de regresión que protegían estos contratos se movieron al nuevo owner sin relajar las invariantes.
- No se inició 6.2.

Adaptación de pruebas

- Se añadió `tests/integration/appBeatDownloadsExtraction.test.ts` para proteger ownership, cancelación antes del worker/runtime, vida de la tarea fuera del modal, atribución por `taskId` y routing Web mediante `platform.downloads`.
- `scripts/run-regressions.mjs` sigue protegiendo runtime, Offline, filename metadata, worker/listener y estado completado, pero busca las responsabilidades de descargas en `useBeatDownloads.ts` donde ahora viven.
- No se desactivaron contratos existentes para hacer pasar la matriz.

Archivos afectados

- src/App.tsx
- src/features/downloads/useBeatDownloads.ts
- src/features/downloads/components/CloudFilesModal.tsx
- tests/integration/appBeatDownloadsExtraction.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 6.1 Apply`, run 34263108889 — SUCCESS.
- Artifact `migration-check-logs-task-6-1-34263108889`, `summary.txt` leído: toda la matriz figura PASS.
- `npm ci` — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- SHA de implementación verificada: de360cdfbf3be7029c5a4df80e097b367efa5e8e.

Comprobaciones no ejecutadas

- `npm run check` — no requerido; la matriz ejecutó individualmente los checks aplicables y quedó completamente verde.
- `npm run test:e2e:downloads` — no aporta verificación de esta extracción: `run-downloads-e2e.mjs` activa `BEATGALER_E2E_DOWNLOADS=1` y el runner sustituye `<App />` por `E2EDownloadsHarness`, por lo que no monta ni ejercita `useBeatDownloads`.
- E2E de import/recovery — fuera del alcance de esta extracción.
- Prueba física Desktop Windows/macOS — no ejecutada; la ronda trabaja mediante GitHub Actions y no dispone de una aplicación física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop: abrir Cloud Files, iniciar una exportación y cerrar inmediatamente el modal; comprobar que la descarga sigue y que su resultado se atribuye al beat/tipo correctos. Repetir cancelando el selector de destino y comprobar que no aparece descarga ni estado downloading.
- Web: iniciar MP3/WAV/PROJECT/ALL cuando exista el asset, cancelar el picker y repetir completándolo.
- Resultado esperado: cerrar la UI no cancela una tarea ya iniciada; cancelar el destino no inicia ninguna; Web sigue su adapter existente y Desktop conserva el worker nativo.

Pendientes / fuera de alcance

- 6.2 — Separar recuperación y errores de uploads queda pendiente y no fue iniciado.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.1.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto quedó abierto por 6.1.

Herramientas temporales restantes

- Ninguna creada por 6.1 debe permanecer tras este commit de cierre. Los appliers/workflows temporales ya fueron retirados y `migration-check-logs/summary.txt` se eliminó del árbol; la evidencia queda en el artifact del run final.

Fallos encontrados y causa

- Run 34260567832: GitHub rechazó la primera definición temporal antes de crear job; fallo de tooling, sin implementación publicada.
- Run 34260842953: unit TS, component DOM e integration pasaron; typecheck/builds fallaron porque el applier retiró `listCloudFilesForBeat`, todavía usado por otra ruta de App, y regressions falló porque guards de filename seguían acoplados físicamente a App. Se restauró el import compartido y se siguió el nuevo owner sin debilitar contratos.
- Run 34261109234: typecheck, unit TS, component DOM, integration y ambos builds pasaron; solo regressions falló porque el guard esperaba la forma `const audioSafeBase = exportMeta`. Se conservó esa forma dentro del nuevo owner.
- Run 34261406758: definición temporal inválida; no creó jobs ni artifacts.
- Run 34261510743: todos los checks salvo regressions pasaron; un guard de la máquina runtime seguía exigiendo `DOWNLOAD_STARTED` físicamente en App. Se mantuvieron los otros flows en App y se movió solo la comprobación de descarga al nuevo owner.
- Run 34261807383: todos los checks salvo regressions pasaron; guards Offline/worker/listener/completion seguían acoplados a App. Se trasladaron juntos al owner real manteniendo sus invariantes.
- Run 34263108889: toda la matriz quedó PASS, publicó `de360cdfbf3be7029c5a4df80e097b367efa5e8e` y retiró el tooling temporal de aplicación.

Veredicto

Terminada.

Las descargas de exportación quedaron fuera de `App.tsx` conservando MP3/WAV/PROJECT/ALL, paquetes Offline, diferencias Web/Desktop, cancelación del destino, vida de la tarea al cerrar el modal y atribución estricta de resultados por `taskId`.

Siguiente tarea

6.2 — Separar recuperación y errores de uploads.

No iniciada.
```
'''
register_path.write_text(register.rstrip() + entry.rstrip() + "\n")

state_path = Path("migration/BeatGaler-agent-state.md")
state_path.write_text(r'''# BeatGaler — Agent State

Fecha de ejecución: 2026-09-08
Rama de trabajo obligatoria: `v0.9.0-test-noche`

## Estado actual

- Tarea trabajada: **6.1 — Separar las descargas de exportación**
- Estado: **Terminada**
- Última tarea terminada: **6.1 — Separar las descargas de exportación**
- SHA inicial de esta ejecución: `58371aa0c291d18cf03b81b6a2adb6ed8c27ca31`
- SHA final de implementación verificada: `de360cdfbf3be7029c5a4df80e097b367efa5e8e`
- Run de verificación principal: **34263108889 — SUCCESS**
- Comprobaciones pendientes para 6.1: **ninguna**

## Resultado verificado

- `useBeatDownloads` posee estado/acciones de Cloud Files, selección de destino, routing Web/Desktop, seguimiento por `taskId` y listener Desktop.
- Cancelar el destino no inicia worker ni estado runtime; cerrar el modal no elimina la tarea iniciada porque listener/tracking viven fuera de la UI.
- Web reutiliza `platform.downloads`; Desktop conserva `startBackgroundDownload`, MP3/WAV/PROJECT/ALL, paquetes Offline y filenames `[BPM Key]`.
- Run 34263108889 terminó PASS en npm ci, diff-check, typecheck, unit TS, component DOM, integration, regressions, build:web y build.

## Pendientes concretos / fuera de alcance

- 6.2 — Separar recuperación y errores de uploads queda pendiente y no fue iniciado.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.1.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.
- No deben quedar herramientas temporales creadas por 6.1 en el árbol final.

## Siguiente tarea

- **6.2 — Separar recuperación y errores de uploads**
- Estado: **Pendiente**
- No iniciarla hasta la próxima ronda.
''')
