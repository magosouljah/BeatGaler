from pathlib import Path

path = Path("src/components/Drawer.tsx")
text = path.read_text(encoding="utf-8")

old_refresh = '''  const refreshCloudFiles = useCallback(async () => {
    if (!beat.telegram_file_id) {
'''
new_refresh = '''  const refreshCloudFiles = useCallback(async () => {
    // Web's editable file surface is backed by the library manifest + platform.editor.
    // Do not probe the legacy Desktop cloud-file bridge just because Drawer opened.
    if (platform.kind === "web") {
      setCloudFiles([]);
      setCloudError(null);
      return;
    }
    if (!beat.telegram_file_id) {
'''
if text.count(old_refresh) != 1:
    raise SystemExit(f"refreshCloudFiles marker count={text.count(old_refresh)}")
text = text.replace(old_refresh, new_refresh, 1)

old_save = '''      if (platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk && !onCloudMutationCommit) {'''
new_save = '''      if (platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk) {'''
if text.count(old_save) != 1:
    raise SystemExit(f"browser edit save marker count={text.count(old_save)}")
text = text.replace(old_save, new_save, 1)

path.write_text(text, encoding="utf-8")
