from pathlib import Path

path = Path(__file__).resolve().parent / "task-8-3-apply-temp.py"
text = path.read_text(encoding="utf-8")

old_assertion = '    expect(owner).not.toContain(".arrayBuffer(");\n'
new_assertion = '    const codeOnly = owner.replace(/\\/\\/.*$/gm, "");\n    expect(codeOnly).not.toContain(".arrayBuffer(");\n'
if text.count(old_assertion) != 1:
    raise SystemExit(f"Expected one focal zero-copy assertion, found {text.count(old_assertion)}")
text = text.replace(old_assertion, new_assertion, 1)

old_splice = 'app = app[:effect_start] + composition + app[effect_end:]\n'
new_splice = '''effect_start = app.find(effect_start_marker)\neffect_end = app.find(effect_end_marker, effect_start)\nif effect_start < 0 or effect_end < 0:\n    raise SystemExit("Could not relocate native drag/drop effect after App import cleanup")\napp = app[:effect_start] + composition + app[effect_end:]\n'''
if text.count(old_splice) != 1:
    raise SystemExit(f"Expected one App native-effect splice, found {text.count(old_splice)}")
text = text.replace(old_splice, new_splice, 1)

old_path_import = '    \'import { extensionFromPath, fileNameFromPath } from "./features/dragdrop/pathHelpers";\',\n'
new_path_import = '    \'import { extensionFromPath, fileNameFromPath, isBackupFolderPath } from "./features/dragdrop/pathHelpers";\',\n'
if text.count(old_path_import) != 1:
    raise SystemExit(f"Expected one App path-helper replacement target, found {text.count(old_path_import)}")
text = text.replace(old_path_import, new_path_import, 1)

path.write_text(text, encoding="utf-8", newline="\n")

target_test_path = Path(__file__).resolve().parents[1] / "tests/integration/appNativeDropTargetsExtraction.test.ts"
target_test = target_test_path.read_text(encoding="utf-8")
old_reads = 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst targets = readFileSync(resolve(process.cwd(), "src/features/dragdrop/nativeDropTargets.ts"), "utf8");\n'
new_reads = 'const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst nativeDropOwner = readFileSync(resolve(process.cwd(), "src/features/dragdrop/useNativeLibraryDrop.ts"), "utf8");\nconst targets = readFileSync(resolve(process.cwd(), "src/features/dragdrop/nativeDropTargets.ts"), "utf8");\n'
if target_test.count(old_reads) != 1:
    raise SystemExit(f"Expected one task 8.1 test read block, found {target_test.count(old_reads)}")
target_test = target_test.replace(old_reads, new_reads, 1)
for old, new in [
    ('    expect(app).toContain("resolveNativeFilesystemDropTarget(payload.paths, payload.position)");\n', '    expect(nativeDropOwner).toContain("resolveNativeFilesystemDropTarget(payload.paths, payload.position)");\n'),
    ('    expect(app).toContain("resolveNativeExternalImageDropTarget(position)");\n', '    expect(nativeDropOwner).toContain("resolveNativeExternalImageDropTarget(position)");\n'),
]:
    if target_test.count(old) != 1:
        raise SystemExit(f"Expected one task 8.1 ownership assertion, found {target_test.count(old)}: {old.strip()}")
    target_test = target_test.replace(old, new, 1)
target_test_path.write_text(target_test, encoding="utf-8", newline="\n")

print("Corrected focal assertion, App splice offsets, preserved App isBackupFolderPath import, and moved task 8.1 ownership assertions to the new native receiver.")
