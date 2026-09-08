from pathlib import Path

app_path = Path('src/App.tsx')
app = app_path.read_text()

# The background imported-beat upload pipeline still owns its automatic PROJECT stage.
# Keep those service dependencies in App until the cloud upload task moves that pipeline.
anchor = 'downloadCookingDiagnosticEvent, uploadDroppedFileToTelegram'
if anchor not in app:
    raise SystemExit('tauri import anchor missing')
app = app.replace(anchor, 'downloadCookingDiagnosticEvent, uploadProjectToTelegram, getProjectCloudStatus, uploadDroppedFileToTelegram', 1)

# The visual notice remains rendered by App, but its state owner is the projects hook.
if '    projectUpdateNotice,\n' not in app:
    raise SystemExit('project notice destructuring missing')
app = app.replace('    projectUpdateNotice,\n', '    projectUpdateNotice,\n    dismissProjectUpdateNotice,\n', 1)
if 'onClick={() => setProjectUpdateNotice(null)}' not in app:
    raise SystemExit('project notice close action missing')
app = app.replace('onClick={() => setProjectUpdateNotice(null)}', 'onClick={dismissProjectUpdateNotice}', 1)
app_path.write_text(app)

projects_path = Path('src/features/projects/useBeatProjects.ts')
projects = projects_path.read_text()
needle = '  const handleUploadProjectTelegram = useCallback((beat: Beat) => syncCurrentProject(beat, "upload"), [syncCurrentProject]);\n'
if needle not in projects:
    raise SystemExit('projects hook action anchor missing')
projects = projects.replace(needle, '  const dismissProjectUpdateNotice = useCallback(() => setProjectUpdateNotice(null), []);\n' + needle, 1)
old_return = '  return { openableCloudProjectIds, projectUpdateNotice, hasStoredProject, startProjectAssetUpdate, handleAutoProjectDrop, handleBrowserProjectDrop, handleUploadProjectTelegram, handleOpenProject, handleUpdateProject };\n'
new_return = '  return { openableCloudProjectIds, projectUpdateNotice, dismissProjectUpdateNotice, hasStoredProject, startProjectAssetUpdate, handleAutoProjectDrop, handleBrowserProjectDrop, handleUploadProjectTelegram, handleOpenProject, handleUpdateProject };\n'
if old_return not in projects:
    raise SystemExit('projects hook return anchor missing')
projects_path.write_text(projects.replace(old_return, new_return, 1))

# This test protects browser artwork ordering, not the physical location of project code.
test_path = Path('tests/integration/issue97WebRoutingContract.test.ts')
test = test_path.read_text()
old_marker = '      "const hasStoredProject = useCallback",\n'
new_marker = '      "const {\\n    runBeatCloudUpdate,",\n'
if old_marker not in test:
    raise SystemExit('web routing section marker missing')
test_path.write_text(test.replace(old_marker, new_marker, 1))

# Folder routing remains in App while PROJECT mutation ownership moved to the hook.
reg_path = Path('scripts/regression-phase9cd.mjs')
reg = reg_path.read_text()
old_guard = "if (!projects.includes('startProjectAssetUpdate(beat, filePath, \"projectFolder\")')) fail(\"PROJECT folder/Samples update route disappeared.\");"
new_guard = "if (!app.includes('startProjectAssetUpdate(beat, filePath, \"projectFolder\")') || !projects.includes('kind: \"projectFile\" | \"projectFolder\"')) fail(\"PROJECT folder/Samples update route disappeared.\");"
if old_guard not in reg:
    raise SystemExit('project folder regression guard missing')
reg_path.write_text(reg.replace(old_guard, new_guard, 1))
