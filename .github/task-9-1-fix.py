from pathlib import Path

app_path = Path("src/App.tsx")
app = app_path.read_text()
old_import = 'import { useSessionState } from "./features/session/useSessionState";'
new_import = 'import { useSessionState, type ConnectionState } from "./features/session/useSessionState";'
if app.count(old_import) != 1:
    raise SystemExit(f"session import fix: expected one match, got {app.count(old_import)}")
app_path.write_text(app.replace(old_import, new_import, 1))

regression_path = Path("scripts/run-regressions.mjs")
regression = regression_path.read_text()
old_owner = '  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");\n'
new_owner = old_owner + '  const customCursor = readFileSync(path.join(root, "src", "features", "session", "useCustomCursor.ts"), "utf8");\n'
if regression.count(old_owner) != 1:
    raise SystemExit(f"cursor owner declaration: expected one match, got {regression.count(old_owner)}")
regression = regression.replace(old_owner, new_owner, 1)

old_guard = '''  if (app.includes('input, textarea, [contenteditable=\\"true\\"]')) fail("Global custom-cursor CSS reintroduced cursor:text for every input; range sliders would show an I-beam again.");
  if (!app.includes('input[type=\\"text\\"]') || !app.includes('input[type=\\"email\\"]') || !app.includes('[contenteditable=\\"true\\"]')) fail("Custom-cursor CSS lost the explicit text-editing input whitelist.");
'''
new_guard = '''  if (customCursor.includes('input, textarea, [contenteditable=\\"true\\"]')) fail("Global custom-cursor CSS reintroduced cursor:text for every input; range sliders would show an I-beam again.");
  if (!customCursor.includes('input[type=\\"text\\"]') || !customCursor.includes('input[type=\\"email\\"]') || !customCursor.includes('[contenteditable=\\"true\\"]')) fail("Custom-cursor CSS lost the explicit text-editing input whitelist.");
'''
if regression.count(old_guard) != 1:
    raise SystemExit(f"cursor guard adaptation: expected one match, got {regression.count(old_guard)}")
regression_path.write_text(regression.replace(old_guard, new_guard, 1))
