from pathlib import Path

p = Path('scripts/run-regressions.mjs')
t = p.read_text()
replacements = {
    "if (!app.includes('inspectProjectDropSource(filePath)')) fail(\"Project files/ZIPs lost automatic destination inspection.\");":
        "if (!beatProjects.includes('inspectProjectDropSource(filePath)')) fail(\"Project files/ZIPs lost automatic destination inspection.\");",
    "if (!app.includes('Backup folders were found in') || !app.includes('Backup folders were skipped from') || !tauriClient.includes('has_backups: boolean')) fail(\"Nested Backup/Backups filtering must be surfaced before and after project updates.\");":
        "if (!beatProjects.includes('Backup folders were found in') || !beatProjects.includes('Backup folders were skipped from') || !tauriClient.includes('has_backups: boolean')) fail(\"Nested Backup/Backups filtering must be surfaced before and after project updates.\");",
}
for old, new in replacements.items():
    if old not in t:
        raise SystemExit(f'missing regression owner guard: {old}')
    t = t.replace(old, new, 1)
p.write_text(t)
