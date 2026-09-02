from pathlib import Path

app_path = Path("src/App.tsx")
app = app_path.read_text(encoding="utf-8")
old_prop = 'onCloudMutationCommit={commitDrawerCloudMutation}'
new_prop = 'onCloudMutationCommit={platform.capabilities.browserCloudEditing ? undefined : commitDrawerCloudMutation}'
count = app.count(old_prop)
if count != 2:
    raise SystemExit(f"expected two Drawer cloud commit props, found {count}")
app = app.replace(old_prop, new_prop)
app_path.write_text(app, encoding="utf-8")

drawer_path = Path("src/components/Drawer.tsx")
drawer = drawer_path.read_text(encoding="utf-8")
old = 'if (platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk) {'
new = 'if (platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk && !onCloudMutationCommit) {'
if drawer.count(old) != 1:
    raise SystemExit(f"expected one browser edit owner branch, found {drawer.count(old)}")
drawer = drawer.replace(old, new, 1)
drawer_path.write_text(drawer, encoding="utf-8")
