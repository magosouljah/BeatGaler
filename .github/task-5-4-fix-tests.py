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

# Regression guard: Delete/Trash stay in App, but SET_OFFLINE_AVAILABLE now
# belongs to the extracted Offline owner. The same definitive runtime contract
# remains required.
reg_path = Path("scripts/run-regressions.mjs")
reg = reg_path.read_text()
projects_line = '  const beatProjects = readFileSync(path.join(root, "src", "features", "projects", "useBeatProjects.ts"), "utf8");\n'
offline_owner_line = '  const offlineAvailability = readFileSync(path.join(root, "src", "features", "offline", "useOfflineAvailability.ts"), "utf8");\n'
if offline_owner_line not in reg:
    if projects_line not in reg:
        raise SystemExit("Regression projects anchor not found")
    reg = reg.replace(projects_line, projects_line + offline_owner_line, 1)
old_guard = '  if (!app.includes(\'type: "SYNC_DELETE_STARTED"\') || !app.includes(\'type: "SET_TRASH_SYNC_REQUIRED"\') || !app.includes(\'type: "SET_OFFLINE_AVAILABLE"\')) fail("Delete/Trash/Offline flows are no longer wired to the definitive runtime registry.");\n'
new_guard = '  if (!app.includes(\'type: "SYNC_DELETE_STARTED"\') || !app.includes(\'type: "SET_TRASH_SYNC_REQUIRED"\') || !offlineAvailability.includes(\'type: "SET_OFFLINE_AVAILABLE"\')) fail("Delete/Trash/Offline flows are no longer wired to the definitive runtime registry.");\n'
if old_guard not in reg:
    raise SystemExit("Regression Offline runtime guard anchor not found")
reg = reg.replace(old_guard, new_guard, 1)
reg_path.write_text(reg)
