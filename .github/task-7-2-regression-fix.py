from pathlib import Path

path = Path('scripts/regression-import-native.mjs')
text = path.read_text(encoding='utf-8')

old_read = 'const app = read("src/App.tsx");\nconst htmlController = read("src/features/dragdrop/htmlDropController.ts");\n'
new_read = 'const app = read("src/App.tsx");\nconst importDiscovery = read("src/features/import/useImportDiscovery.ts");\nconst htmlController = read("src/features/dragdrop/htmlDropController.ts");\n'
if text.count(old_read) != 1:
    raise SystemExit(f'expected one import/native owner read block, found {text.count(old_read)}')
text = text.replace(old_read, new_read, 1)

old_guard = 'if (!app.includes("startImportReviewStream(normalized)")) fail("native import no longer starts the incremental Review stream.");'
new_guard = 'if (!importDiscovery.includes("startStream: startImportReviewStream") || !importDiscovery.includes("await services.startStream(normalized)")) fail("native import no longer starts the incremental Review stream.");'
if text.count(old_guard) != 1:
    raise SystemExit(f'expected one incremental Review guard, found {text.count(old_guard)}')
text = text.replace(old_guard, new_guard, 1)
path.write_text(text, encoding='utf-8')

for temp in [
    '.github/task-7-2-regression-fix.py',
    '.github/workflows/temp-task-7.2-retry3.yml',
]:
    candidate = Path(temp)
    if candidate.exists():
        candidate.unlink()
