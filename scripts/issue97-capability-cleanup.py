from pathlib import Path

app_path = Path("src/App.tsx")
app = app_path.read_text(encoding="utf-8")
old_guard = '    if (platform.kind === "web") return;\n    if (connectionState !== "online" || !cloudSessionVerified) return;'
new_guard = '    if (platform.capabilities.browserCloudEditing) return;\n    if (connectionState !== "online" || !cloudSessionVerified) return;'
if app.count(old_guard) != 1:
    raise SystemExit(f"App metadata guard count={app.count(old_guard)}")
app = app.replace(old_guard, new_guard, 1)

marker = '  const handleDropArtwork = useCallback(async (beat: Beat, imageBase64: string) => {'
start = app.find(marker)
end = app.find('  const runBeatCloudUpdate = useCallback', start)
if start < 0 or end < 0:
    raise SystemExit("handleDropArtwork section not found")
section = app[start:end]
if section.count('if (platform.kind === "web") {') != 1:
    raise SystemExit("expected one Web artwork branch")
section = section.replace('if (platform.kind === "web") {', 'if (platform.capabilities.browserCloudEditing) {', 1)
app = app[:start] + section + app[end:]
app_path.write_text(app, encoding="utf-8")

drawer_path = Path("src/components/Drawer.tsx")
drawer = drawer_path.read_text(encoding="utf-8")
refresh_start = drawer.find('  const refreshCloudFiles = useCallback')
refresh_end = drawer.find('  const handleCloudDownload', refresh_start)
if refresh_start < 0 or refresh_end < 0:
    raise SystemExit("refreshCloudFiles section not found")
refresh = drawer[refresh_start:refresh_end]
if refresh.count('if (platform.kind === "web") {') != 1:
    raise SystemExit("expected one Drawer Web refresh guard")
refresh = refresh.replace('if (platform.kind === "web") {', 'if (platform.capabilities.browserCloudEditing) {', 1)
drawer = drawer[:refresh_start] + refresh + drawer[refresh_end:]
drawer_path.write_text(drawer, encoding="utf-8")
