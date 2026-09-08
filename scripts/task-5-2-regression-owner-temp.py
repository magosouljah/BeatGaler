from pathlib import Path

path = Path("scripts/run-regressions.mjs")
text = path.read_text()

anchor = '  const drawerCloudPersistence = readFileSync(path.join(root, "src", "features", "edit", "useDrawerCloudPersistence.ts"), "utf8");\n'
owner = '  const beatAssetUpdates = readFileSync(path.join(root, "src", "features", "edit", "useBeatAssetUpdates.ts"), "utf8");\n'
if owner not in text:
    if anchor not in text:
        raise SystemExit("owner anchor missing")
    text = text.replace(anchor, anchor + owner, 1)

old_close = '  if (!app.includes(\'setBeatFileDrop(null);\') || !app.includes(\'const runBeatCloudUpdate\')) fail("Long beat updates must close the chooser before background work starts.");'
new_close = '  if (!beatAssetUpdates.includes(\'setBeatFileDrop(null);\') || !beatAssetUpdates.includes(\'const runBeatCloudUpdate\')) fail("Long beat updates must close the chooser before background work starts.");'
if old_close in text:
    text = text.replace(old_close, new_close, 1)
elif new_close not in text:
    raise SystemExit("close guard missing")

old_success = '  if (!app.includes(\'setBeatCloudUpdateBusy(beat.id, false, true)\')) fail("Successful existing-beat updates lost the success-phase event.");'
new_success = '  if (!beatAssetUpdates.includes(\'setBeatCloudUpdateBusy(beat.id, false, true)\')) fail("Successful existing-beat updates lost the success-phase event.");'
if old_success in text:
    text = text.replace(old_success, new_success, 1)
elif new_success not in text:
    raise SystemExit("success guard missing")

path.write_text(text)
