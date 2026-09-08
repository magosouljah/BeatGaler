from pathlib import Path

roadmap_path = Path('migration/BeatGaler-roadmap-para-trabajar-con-IAs.md')
registro_path = Path('migration/Registro-de-avance.md')
agent_path = Path('migration/BeatGaler-agent-state.md')

roadmap = roadmap_path.read_text(encoding='utf-8')
old = '### [ ] 7.2 — Separar descubrimiento incremental'
new = '### [x] 7.2 — Separar descubrimiento incremental'
if roadmap.count(old) != 1:
    raise SystemExit(f'roadmap: expected one pending 7.2 marker, found {roadmap.count(old)}')
if '### [x] 7.3 — Separar Save All y conflictos' in roadmap:
    raise SystemExit('roadmap: 7.3 was already started unexpectedly')
roadmap_path.write_text(roadmap.replace(old, new, 1), encoding='utf-8')

registro = registro_path.read_text(encoding='utf-8')
if '### Registro — 7.2' in registro:
    raise SystemExit('registro: task 7.2 entry already exists')
entry = r'''

### Registro — 7.2

```
Tarea: 7.2 — Separar descubrimiento incremental
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 01e4c439ef4e251a5c94d0d46b907bfdf0745e3b
- SHA de implementación validada: 8923a1790b9dd0d126760ae54908678a44f78025
- Última tarea verificada: 7.1 — Separar Review y sus acciones básicas

Cambio realizado

- Se creó `src/features/import/useImportDiscovery.ts` como dueño del descubrimiento/preparación incremental de Review.
- El hook posee el bootstrap visual, las generaciones de cancelación/reemplazo, el cursor de preparación, el worker secuencial de Beat 2..N y la promesa compartida que Save All espera mientras 7.3 siga en App.
- `App.tsx` dejó de poseer `startImportReviewStream`, `prepareNextImportReviewBeat`, `getImportReviewBatchSummary`, `reviewPreparationRunRef`, `importReviewRequestRunRef` y el cuerpo de `importDroppedPaths`.
- Se preservó el camino crítico: crear stream, preparar solo Beat 1, publicar Review, esperar un frame y recién entonces continuar Beat 2..N en background con yields entre pasos.
- Cancel/reemplazo incrementan generaciones; resultados tardíos solo se descartan y no pueden volver a abrir candidatos antiguos.
- La entrada Web permanece en App para 7.4. Usa `completeImmediateReviewPreparation()` como conexión mínima para cerrar el estado visual de discovery sin mover esa entrada antes de tiempo.
- Save All y conflictos permanecen en App para 7.3 y siguen esperando `reviewPreparationPromiseRef.current`.

Adaptación de pruebas

- Se añadió `tests/component-dom/importDiscovery.test.tsx`: verifica que Beat 1 aparezca antes de terminar el escaneo y que un stream que resuelve después de Cancel se descarte sin reabrir Review.
- Se añadió `tests/integration/appImportDiscoveryExtraction.test.ts`: protege ownership, orden skeleton → stream → Beat 1 → frame → background y generaciones obsoletas.
- `tests/integration/appMigrationCharacterization.test.ts` se adaptó al nuevo límite de ownership sin relajar los contratos de Review.
- `scripts/run-regressions.mjs` sigue protegiendo el worker incremental desde su nuevo owner.
- `scripts/regression-import-native.mjs` sigue comprobando que el drop nativo entra al stream incremental, leyendo la creación/ejecución del stream en `useImportDiscovery.ts` en lugar de exigirla físicamente en App.

Archivos afectados

- src/App.tsx
- src/features/import/useImportDiscovery.ts
- tests/component-dom/importDiscovery.test.tsx
- tests/integration/appImportDiscoveryExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- scripts/run-regressions.mjs
- scripts/regression-import-native.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary task 7.2 retry 3`, run 34287602453 — SUCCESS.
- `git diff --check` — PASS.
- Pruebas focalizadas de 7.2 — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- Artifact de la corrida final: `summary.txt` indicó `Migration checks: PASS` y los siete checks anteriores PASS.
- El `summary.txt` generado por el runner se retiró del árbol después de usarlo como evidencia; no forma parte del producto.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente todos los checks aplicables del plan.
- Prueba física Desktop Windows/macOS no ejecutada; esta extracción se validó en GitHub Actions y no cambia comandos nativos ni el algoritmo Rust de discovery.
- E2E completos ajenos al flujo de discovery incremental no fueron necesarios para cerrar esta extracción.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: arrastrar una carpeta grande con varios beats y comprobar que Review del primer beat aparece antes de completar el escaneo; cancelar mientras el descubrimiento continúa y comprobar que ningún candidato antiguo reaparece.

Pendientes / fuera de alcance

- 7.3 — Separar Save All y conflictos queda pendiente y no fue iniciada.
- 7.4 — Separar la entrada de importación web permanece pendiente.
- Save All conserva temporalmente la conexión a `reviewPreparationPromiseRef` hasta 7.3.

Riesgos previos relevantes

- No se identificó un nuevo riesgo de producto causado por 7.2.

Herramientas temporales restantes

- Ninguna creada por 7.2 debe permanecer al cerrar. Los appliers, scripts auxiliares y el closer se eliminan del árbol final.

Fallos encontrados y causa

- Run 34286938464 falló antes de tocar producto por una búsqueda textual frágil del aplicador; no publicó código.
- Un retry intermedio fue rechazado por YAML antes de crear jobs; no ejecutó código ni modificó producto.
- Run 34287215740 llegó a typecheck y detectó que la entrada Web todavía necesitaba cerrar `reviewPreparationDone`/`reviewBootstrap`; se resolvió con una conexión mínima `completeImmediateReviewPreparation()` sin adelantar 7.4. No publicó producto.
- Run 34287376904 pasó typecheck, pruebas focalizadas, unit, component DOM, integración y builds; solo falló regressions porque `regression-import-native.mjs` exigía `startImportReviewStream(normalized)` físicamente en App. Se adaptó el guard al nuevo owner sin relajar el contrato.
- Run 34287602453 quedó completamente verde y publicó la implementación validada.

Veredicto

Terminada.

El descubrimiento incremental salió de `App.tsx` conservando Review temprano de Beat 1, worker secuencial para el resto y cancelación/reemplazo segura de resultados obsoletos.

Siguiente tarea

7.3 — Separar Save All y conflictos.

No iniciada.
```
'''
registro_path.write_text(registro.rstrip() + entry + '\n', encoding='utf-8')

agent = '''# BeatGaler — Agent State

## Contexto

- Fecha de ejecución: 2026-09-08
- Rama de trabajo: `v0.9.0-test-noche`
- Tarea trabajada: `7.2 — Separar descubrimiento incremental`
- Estado: `Terminada`
- Última tarea terminada: `7.2 — Separar descubrimiento incremental`

## Base de esta ejecución

- SHA inicial: `01e4c439ef4e251a5c94d0d46b907bfdf0745e3b`
- SHA de implementación validada: `8923a1790b9dd0d126760ae54908678a44f78025`
- HEAD después de retirar el artifact generado por CI y antes del cierre documental: `d993cabe4a4aaf3c661cb68afd604734a529720f`
- Run de implementación final: `34287602453` — `Temporary task 7.2 retry 3` — `SUCCESS`
- El SHA final real de la ronda es el HEAD remoto que debe leerse nuevamente después de este cierre documental; no se anticipa dentro del propio commit de cierre.

## Resultado verificado

- `useImportDiscovery.ts` posee el descubrimiento/preparación progresiva y sus generaciones de cancelación.
- Beat 1 se publica antes de que termine el escaneo completo; el resto continúa secuencialmente en background después de un frame.
- Cancel/reemplazo invalidan trabajo obsoleto; un resultado tardío se descarta y no reabre Review.
- Save All sigue esperando la misma promesa de preparación y permanece en App hasta 7.3.
- La entrada Web permanece en App hasta 7.4 y usa una conexión mínima para cerrar el estado visual de discovery.
- La matriz completa pasó sobre la implementación validada y el guard nativo sigue comprobando que las rutas originales entran al stream incremental.

## Pendientes concretos

- `7.3 — Separar Save All y conflictos`.
- `7.4 — Separar la entrada de importación web` permanece posterior a 7.3.

## Comprobaciones pendientes

- Ninguna necesaria para cerrar 7.2.

## Siguiente tarea

- `7.3 — Separar Save All y conflictos`
- Estado: `Pendiente`
- No iniciar hasta la próxima ronda.
'''
agent_path.write_text(agent, encoding='utf-8')

for path in [
    '.github/task-7-2-close.py',
    '.github/workflows/temp-task-7.2-close.yml',
]:
    candidate = Path(path)
    if candidate.exists():
        candidate.unlink()
