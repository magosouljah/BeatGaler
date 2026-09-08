from pathlib import Path

# New characterization test: follow the repository's Vitest convention so it
# works under the current runner transform mode.
test_path = Path("tests/integration/appOfflineAvailabilityExtraction.test.ts")
test = test_path.read_text()
test = test.replace('import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\nconst app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");\nconst offline = readFileSync(new URL("../../src/features/offline/useOfflineAvailability.ts", import.meta.url), "utf8");', 'import { readFileSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { describe, expect, it } from "vitest";\n\nconst app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst offline = readFileSync(resolve(process.cwd(), "src/features/offline/useOfflineAvailability.ts"), "utf8");')
test_path.write_text(test)

# Playback extraction guard: invalidation is still owned by the playback
# controller, while task 5.4 legitimately moves its Offline call site from App
# into the explicit Offline owner.
playback_test_path = Path("tests/integration/appPlaybackExtraction.test.ts")
playback_test = playback_test_path.read_text()
controller_line = 'const controllerSource = readFileSync(resolve(process.cwd(), "src/features/playback/usePlaybackController.ts"), "utf8");\n'
offline_line = 'const offlineSource = readFileSync(resolve(process.cwd(), "src/features/offline/useOfflineAvailability.ts"), "utf8");\n'
if offline_line not in playback_test:
    if controller_line not in playback_test:
        raise SystemExit("Playback test controller anchor not found")
    playback_test = playback_test.replace(controller_line, controller_line + offline_line, 1)
old_expect = "    expect(appSource).toContain('invalidatePlaybackPreparation(beat.id)');\n"
new_expect = "    expect(offlineSource).toContain('invalidatePlaybackPreparation(beat.id)');\n"
if old_expect not in playback_test:
    raise SystemExit("Playback invalidation expectation anchor not found")
playback_test = playback_test.replace(old_expect, new_expect, 1)
playback_test_path.write_text(playback_test)

# Regression guards: Delete/Trash stay in App, while task 5.4 moves Offline
# runtime wiring and the durable-removal call site into the explicit owner.
reg_path = Path("scripts/run-regressions.mjs")
reg = reg_path.read_text()
projects_line = '  const beatProjects = readFileSync(path.join(root, "src", "features", "projects", "useBeatProjects.ts"), "utf8");\n'
offline_owner_line = '  const offlineAvailability = readFileSync(path.join(root, "src", "features", "offline", "useOfflineAvailability.ts"), "utf8");\n'
if offline_owner_line not in reg:
    if projects_line not in reg:
        raise SystemExit("Regression projects anchor not found")
    reg = reg.replace(projects_line, projects_line + offline_owner_line, 1)

old_runtime_guard = '  if (!app.includes(\'type: "SYNC_DELETE_STARTED"\') || !app.includes(\'type: "SET_TRASH_SYNC_REQUIRED"\') || !app.includes(\'type: "SET_OFFLINE_AVAILABLE"\')) fail("Delete/Trash/Offline flows are no longer wired to the definitive runtime registry.");\n'
new_runtime_guard = '  if (!app.includes(\'type: "SYNC_DELETE_STARTED"\') || !app.includes(\'type: "SET_TRASH_SYNC_REQUIRED"\') || !offlineAvailability.includes(\'type: "SET_OFFLINE_AVAILABLE"\')) fail("Delete/Trash/Offline flows are no longer wired to the definitive runtime registry.");\n'
if old_runtime_guard not in reg:
    raise SystemExit("Regression Offline runtime guard anchor not found")
reg = reg.replace(old_runtime_guard, new_runtime_guard, 1)

old_fast_path_guard = '  if (!app.includes(\'invalidatePlaybackPreparation(beat.id)\') || !playbackController.includes(\'cookingPlaybackUrlRef.current.delete(beatId)\')) fail("Remove from Available Offline can leave a dead durable MASTER URL in the Fast Play Path.");\n'
new_fast_path_guard = '  if (!offlineAvailability.includes(\'invalidatePlaybackPreparation(beat.id)\') || !playbackController.includes(\'cookingPlaybackUrlRef.current.delete(beatId)\')) fail("Remove from Available Offline can leave a dead durable MASTER URL in the Fast Play Path.");\n'
if old_fast_path_guard not in reg:
    raise SystemExit("Fast Play invalidation guard anchor not found")
reg = reg.replace(old_fast_path_guard, new_fast_path_guard, 1)

old_start = "  const removeOfflineUiStart = app.indexOf('if (beat.offline_available) {', app.indexOf('const handleToggleOffline'));\n"
new_start = "  const removeOfflineUiStart = offlineAvailability.indexOf('if (beat.offline_available) {', offlineAvailability.indexOf('const handleToggleOffline'));\n"
old_end = "  const removeOfflineUiEnd = app.indexOf('} else {\\n        const offline = await makeBeatAvailableOffline(beat);', removeOfflineUiStart);\n"
new_end = "  const removeOfflineUiEnd = offlineAvailability.indexOf('} else {\\n        const offline = await makeBeatAvailableOffline(beat);', removeOfflineUiStart);\n"
old_slice = "  const removeOfflineUiBlock = removeOfflineUiEnd > removeOfflineUiStart ? app.slice(removeOfflineUiStart, removeOfflineUiEnd) : '';\n"
new_slice = "  const removeOfflineUiBlock = removeOfflineUiEnd > removeOfflineUiStart ? offlineAvailability.slice(removeOfflineUiStart, removeOfflineUiEnd) : '';\n"
for old, new, label in [(old_start, new_start, "start"), (old_end, new_end, "end"), (old_slice, new_slice, "slice")]:
    if old not in reg:
        raise SystemExit(f"Offline removal regression {label} anchor not found")
    reg = reg.replace(old, new, 1)

reg_path.write_text(reg)
