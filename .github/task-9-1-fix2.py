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
owner_line = '  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");\n'
cursor_line = '  const customCursor = readFileSync(path.join(root, "src", "features", "session", "useCustomCursor.ts"), "utf8");\n'
if regression.count(owner_line) != 1:
    raise SystemExit(f"cursor owner declaration: expected one app owner, got {regression.count(owner_line)}")
regression = regression.replace(owner_line, owner_line + cursor_line, 1)

lines = regression.splitlines(keepends=True)
changed_global = 0
changed_whitelist = 0
for index, line in enumerate(lines):
    if "Global custom-cursor CSS reintroduced cursor:text for every input" in line:
        if "app.includes" not in line:
            raise SystemExit("global cursor guard no longer reads App as expected")
        lines[index] = line.replace("app.includes", "customCursor.includes")
        changed_global += 1
    elif "Custom-cursor CSS lost the explicit text-editing input whitelist" in line:
        if "app.includes" not in line:
            raise SystemExit("whitelist cursor guard no longer reads App as expected")
        lines[index] = line.replace("app.includes", "customCursor.includes")
        changed_whitelist += 1

if changed_global != 1 or changed_whitelist != 1:
    raise SystemExit(f"cursor guard adaptation counts: global={changed_global}, whitelist={changed_whitelist}")
regression_path.write_text("".join(lines))
