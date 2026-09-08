from pathlib import Path

controller = Path('src/features/playback/usePlaybackController.ts').read_text()
app = Path('src/App.tsx').read_text()
test = Path('tests/integration/appPlaybackExtraction.test.ts').read_text()

required_controller = [
    'beatgaler:playback-cache-cleared',
    'beatgaler:audio-playing',
    'invalidatePlaybackPreparation',
    'PLAY_BLOCKED_LOADING',
    'playbackCacheEpochRef.current !== cacheEpoch',
    'APP_HANDLE_PLAY_ENTER',
    'if (!isTauriAvailable)',
    'prepareBeatForPlayback(beat)',
    'isBeatCloudUpdateBusy(inputBeat.id)',
]
for marker in required_controller:
    assert marker in controller, marker
assert 'usePlaybackController({' in app
assert 'invalidatePlaybackPreparation(beat.id)' in app
assert 'const ensureWarmPlaybackUrl = useCallback' not in app
assert 'APP_HANDLE_PLAY_ENTER' not in app
assert 'beatgaler:playback-cache-cleared' not in app
assert 'cookingPlaybackUrlRef' not in app
assert 'moves playback preparation, invalidation, audio events and play routing out of App' in test

roadmap_path = Path('migration/BeatGaler-roadmap-para-trabajar-con-IAs.md')
roadmap = roadmap_path.read_text()
old = '### [ ] 4.2 — Separar preparación y control del audio'
new = '### [x] 4.2 — Separar preparación y control del audio'
assert old in roadmap
assert '### [x] 4.3 — Separar la cola y navegación' not in roadmap
roadmap_path.write_text(roadmap.replace(old, new, 1))

register_path = Path('migration/Registro-de-avance.md')
register = register_path.read_text().rstrip()
assert '### Registro — 4.2' not in register
entry = '''

### Registro — 4.2

```
Tarea: 4.2 — Separar preparación y control del audio
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: c67ddada2b9bde04ebaa052c6e9ef15876a55c1c
- Última tarea verificada: 4.1 — Separar la carga de portadas
- El pre-flight encontró implementación versionada de 4.2 ya publicada, mientras agent-state, roadmap y registro todavía la mostraban Pendiente. Se trató como recuperación de una ejecución interrumpida y no se repitió la implementación.

Cambio realizado

- La preparación, warm URLs temporales, invalidación de caché, eventos de audio y `handlePlay` viven en `src/features/playback/usePlaybackController.ts`.
- Se conserva una sola instancia de audio mediante `hooks/useAudio.ts`; el nuevo controlador recibe el estado y la acción `play` sin crear otro audio.
- Se conservaron rutas separadas Web/Desktop: Web usa `platform.media.preparePlayback`; Desktop conserva warm/cooking, `prepareBeatForPlayback`, estados runtime y diagnósticos.
- La época de caché impide que una promesa iniciada antes de Clear Cache repueble una URL invalidada.
- La invalidación por beat usada al quitar Available Offline quedó delegada a `invalidatePlaybackPreparation`, eliminando las referencias directas de App a los mapas internos.
- El bloqueo por slot/project update y por estados de preparación se conserva dentro del controlador.
- No se inició 4.3.

Adaptación de pruebas

- `tests/integration/appPlaybackExtraction.test.ts` comprueba que preparation, invalidation, eventos y routing salieron de App y quedaron en el controlador.
- `scripts/run-regressions.mjs` se adaptó al nuevo ownership sin debilitar los contratos de audio real, bloqueo de playback, Clear Cache ni Available Offline.
- Las caracterizaciones relacionadas con playback fueron actualizadas para seguir la responsabilidad en su nuevo módulo.

Archivos afectados por la implementación recuperada

- src/App.tsx
- src/features/playback/usePlaybackController.ts
- tests/integration/appPlaybackExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- tests/integration/issue97RuntimeWebFollowup.test.ts
- scripts/run-regressions.mjs

Archivos afectados por este cierre

- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md
- eliminación de workflows y script temporales de Task 4.2

Comprobaciones ejecutadas

- GitHub Actions `Temporary Task 4.2 Final 4`, run 34220274412 — SUCCESS.
- Artifact `migration-check-logs-task-4-2-34220274412` leído: summary.txt confirma PASS en todos los checks.
- git diff --check — PASS.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.

Comprobaciones no ejecutadas

- npm run check — no requerido para esta extracción; sus checks relevantes se ejecutaron individualmente.
- E2E import/download/recovery — no aplican a esta extracción de ownership de playback.
- Pruebas nativas físicas Windows/macOS — no necesarias para cerrar la extracción; no cambiaron comandos nativos ni adapters.

Prueba manual

- No requerida como bloqueo de cierre. Los contratos críticos de Play repetido, cambio de beat, bloqueo durante preparación, rutas Web/Desktop e invalidación de caché están protegidos por integración/regresiones existentes y los builds aplicables.

Pendientes / fuera de alcance

- 4.3 — Separar cola y navegación sigue pendiente y no fue iniciada.
- El riesgo previo de `handleRemoveBulk` permanece fuera de alcance.

Riesgos previos relevantes

- Ninguno nuevo causado por 4.2.

Herramientas temporales restantes

- Ninguna al cerrar; los workflows temporales `task-4-2-final*.yml`, el finalizador y este script se eliminan en el commit de cierre.

Fallos encontrados y causa

- Run 34220059314: todos los checks salvo regressions pasaron. `summary.txt` marcó únicamente `regressions` como FAIL; el log identificó la guarda `Remove from Available Offline can leave a dead durable MASTER URL in the Fast Play Path.` La causa fue ownership incompleto: App todavía manipulaba directamente los mapas de preparación. Se corrigió exponiendo y usando `invalidatePlaybackPreparation(beat.id)` desde el nuevo controlador.
- Run 34220274412 ejecutó la corrección y terminó completamente verde.
- Run 34220965728 no creó jobs porque el primer workflow temporal de cierre tenía YAML inválido; no modificó código ni documentos.

Veredicto

Terminada.

La preparación y el control de audio quedaron fuera de App conservando un solo audio, las diferencias Web/Desktop, los bloqueos de preparación y la invalidación de rutas temporales.

Siguiente tarea

4.3 — Separar la cola y navegación.

No iniciada.
```
'''
register_path.write_text(register + entry + '\n')

state = '''# BeatGaler Agent State

## Seguridad de la ronda nocturna

- Rama exclusiva: `v0.9.0-test-noche`
- Prohibido modificar o avanzar `integration-v0.9.0-alpha.2`, `main` o ramas `app-tsx-*`.
- Prohibido merge, rebase, cherry-pick, fast-forward hacia otras ramas o PR de integración durante la prueba.
- Todos los commits y pushes de la ronda deben quedar únicamente en `v0.9.0-test-noche`.

## Estado operativo

- Tarea trabajada: `4.2 — Separar preparación y control del audio`
- Estado: `Terminada`
- Última tarea terminada: `4.2 — Separar preparación y control del audio`
- SHA inicial de esta ejecución: `c67ddada2b9bde04ebaa052c6e9ef15876a55c1c`
- SHA final de implementación verificada: `0a710ba25be4fc2ddad81f4cfe8383ba7e71e920`
- Pendientes concretos: ninguno de 4.2.
- Comprobaciones pendientes: ninguna necesaria para reabrir 4.2.
- Siguiente tarea: `4.3 — Separar la cola y navegación`
- Estado de la siguiente tarea: `Pendiente`
- Fecha de ejecución: `2026-09-08`

## Evidencia de cierre de 4.2

- Implementación: preparación, invalidación, eventos de audio y `handlePlay` extraídos a `src/features/playback/usePlaybackController.ts`.
- GitHub Actions: `Temporary Task 4.2 Final 4`, run `34220274412`.
- Artifact: `migration-check-logs-task-4-2-34220274412`, con todos los checks en PASS.
- Commit de implementación verificada: `0a710ba25be4fc2ddad81f4cfe8383ba7e71e920`.
- Se conserva una sola instancia de audio y las rutas distintas Web/Desktop.

## Regla de actualización

Al cerrar cada ejecución:
- si la tarea queda `Terminada`, marcar solo su `[x]` en el roadmap, agregar su registro al final de `Registro-de-avance.md` y dejar aquí la siguiente tarea como `Pendiente`;
- si queda `En curso` o `Por verificar`, mantener esa misma tarea como tarea actual y registrar exactamente lo que falta;
- nunca iniciar una segunda tarea en la misma ejecución.
'''
Path('migration/BeatGaler-agent-state.md').write_text(state)
