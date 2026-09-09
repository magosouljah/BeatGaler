from pathlib import Path

path = Path(__file__).resolve().parent / "task-8-3-apply-temp.py"
text = path.read_text(encoding="utf-8")
old = '    expect(owner).not.toContain(".arrayBuffer(");\n'
new = '    const codeOnly = owner.replace(/\\/\\/.*$/gm, "");\n    expect(codeOnly).not.toContain(".arrayBuffer(");\n'
if text.count(old) != 1:
    raise SystemExit(f"Expected one focal zero-copy assertion, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")
print("Corrected focal test to ignore comments for the arrayBuffer code assertion.")
