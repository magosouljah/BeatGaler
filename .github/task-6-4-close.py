from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INITIAL_SHA = "0ef4255d528e726dd278ba7389575f6d260fe333"
IMPLEMENTATION_SHA = "f9b7029a807966837c39e0844dac03c063024ce3"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def finalize_docs(run_id: str) -> None:
    roadmap_path = "migration/BeatGaler-roadmap-para-trabajar-con-IAs.md"
    roadmap = read(roadmap_path)
    old = "### [ ] 6.4 — Separar la cola de uploads"
    new = "### [x] 6.4 — Separar la cola de uploads"
    if old not in roadmap:
        raise SystemExit("roadmap 6.4 pending marker not found")
    write(roadmap_path, roadmap.replace(old, new, 1))

    registro_path = "migration/Registro-de-avance.md"
    registro = read(registro_path)
    if "### Registro — 6.4" in registro:
        raise SystemExit("Registro 6.4 already exists")
    entry = f'''\n\n### Registro — 6.4\n\n```\nTarea: 6.4 — Separar la cola de uploads\nEstado: Terminada\nFecha: 2026-09-08\n\nBase:\n- Rama: v0.9.0-test-noche\n- SHA inicial: {INITIAL_SHA}\n- SHA de implementación validada: {IMPLEMENTATION_SHA}\n- Última tarea verificada: 6.3 — Separar el proceso de subida de un beat.\n\nCambio realizado:\n- Se extrajo de App.tsx la cola de uploads a src/features/cloud/useCloudUploadQueue.ts.\n- El hook es dueño de cola Desktop, IDs activos, errores por beat, retry, timers de finalización y Reload diferido.\n- Desktop conserva FIFO/secuencialidad y cada beat sigue pasando por runDesktopBeatUploadPipeline de 6.3.\n- Web conserva platform.cloudData.commitImportedBeat como ruta separada.\n- Review/import siguen en App.tsx; la cola solo consulta dos conexiones pequeñas de lectura para proteger staging.\n- Reload delega el diferimiento al hook y el evento existente se dispara solo cuando no queda trabajo de upload activo o en cola.\n\nAdaptación de pruebas:\n- Se agregó appCloudUploadQueueExtraction.test.ts para ownership, orden, Web/Desktop, staging, retry y Reload.\n- appMigrationCharacterization.test.ts, issue97RuntimeWebFollowup.test.ts y run-regressions.mjs siguen al owner real después de la extracción.\n- Los fallos iniciales de integration/regressions fueron clasificados como pruebas/guardas estáticas acopladas a App.tsx; no requirieron cambiar la lógica de producción extraída.\n\nArchivos afectados:\n- src/App.tsx\n- src/features/cloud/useCloudUploadQueue.ts\n- tests/integration/appCloudUploadQueueExtraction.test.ts\n- tests/integration/appMigrationCharacterization.test.ts\n- tests/integration/issue97RuntimeWebFollowup.test.ts\n- scripts/run-regressions.mjs\n- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md\n- migration/Registro-de-avance.md\n- migration/BeatGaler-agent-state.md\n- tooling temporal .github/task-6-4*.py y workflows task-6-4-*.yml — eliminado al cierre.\n\nComprobaciones ejecutadas:\n- Task 6.4 Apply / run 34275548952 / attempt 3: matriz de implementación completa PASS antes de publicar {IMPLEMENTATION_SHA}.\n- npm ci: PASS.\n- git diff --check: PASS.\n- npm run test:typecheck: PASS.\n- npm run test:unit:ts: PASS.\n- npm run test:component:dom: PASS.\n- npm run test:integration: PASS.\n- npm run test:regressions: PASS.\n- npm run build:web: PASS.\n- npm run build: PASS.\n- Task 6.4 Close / run {run_id}: repite la misma matriz después de eliminar todo el tooling temporal y escribir roadmap/registro.\n\nComprobaciones no ejecutadas:\n- Prueba manual Desktop física: no requerida para esta extracción estructural; la matriz automatizada cubre los contratos modificados.\n- E2E completos ajenos al alcance de 6.4: no ejecutados.\n\nPrueba manual:\n- No requerida.\n\nPendientes / fuera de alcance:\n- 7.1 — Separar Review y sus acciones básicas.\n- Cuando Review tenga owner propio, sustituir las conexiones temporales isReviewActive / hasProtectedStaging sin perder protección de staging.\n\nRiesgos previos relevantes:\n- Se conserva la frontera durable del pipeline 6.3.\n\nHerramientas temporales restantes:\n- Ninguna al cierre.\n\nVeredicto:\n- Terminada, sujeto a PASS de la revalidación de cierre del run {run_id}.\n\nSiguiente tarea:\n- 7.1 — Separar Review y sus acciones básicas. No iniciada.\n```\n'''
    write(registro_path, registro.rstrip() + entry.rstrip() + "\n")


def finalize_state(closure_sha: str, run_id: str) -> None:
    state = f'''# BeatGaler — Agent State\n\n## Contexto\n\n- Fecha de ejecución: 2026-09-08\n- Rama de trabajo: `v0.9.0-test-noche`\n- Tarea trabajada: `6.4 — Separar la cola de uploads`\n- Estado: `Terminada`\n- Última tarea terminada: `6.4 — Separar la cola de uploads`\n\n## Base de esta ejecución\n\n- SHA inicial: `{INITIAL_SHA}`\n- SHA de implementación validada: `{IMPLEMENTATION_SHA}`\n- SHA de cierre revalidado tras eliminar tooling temporal: `{closure_sha}`\n- HEAD remoto observado inmediatamente antes de la escritura final de agent-state: `{closure_sha}`\n- Run de cierre: `{run_id}` — `Task 6.4 Close` — matriz de cierre `SUCCESS`\n\n## Resultado verificado\n\n- `useCloudUploadQueue.ts` es dueño de cola, IDs activos, errores, retry, timers y Reload diferido.\n- Desktop conserva FIFO/secuencialidad y delega cada beat al pipeline 6.3.\n- Web conserva `platform.cloudData.commitImportedBeat`.\n- App conserva wiring y dos lecturas temporales hacia Review/staging.\n- El Reload pendiente se consume solo cuando no quedan uploads activos ni en cola.\n- La matriz completa pasó sobre `{IMPLEMENTATION_SHA}` y volvió a pasar después de eliminar todo el tooling temporal y escribir roadmap/registro.\n\n## Pendientes concretos\n\n- `7.1 — Separar Review y sus acciones básicas`.\n- Sustituir `isReviewActive` / `hasProtectedStaging` cuando Review tenga owner propio.\n\n## Comprobaciones pendientes\n\n- Ninguna necesaria para cerrar 6.4.\n\n## Siguiente tarea\n\n- `7.1 — Separar Review y sus acciones básicas`\n- Estado: `Pendiente`\n- No iniciar hasta la próxima ronda.\n'''
    write("migration/BeatGaler-agent-state.md", state)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "docs":
        finalize_docs(sys.argv[2])
        return
    if len(sys.argv) == 4 and sys.argv[1] == "state":
        finalize_state(sys.argv[2], sys.argv[3])
        return
    raise SystemExit("usage: task-6-4-close.py docs RUN_ID | state CLOSURE_SHA RUN_ID")


if __name__ == "__main__":
    main()
