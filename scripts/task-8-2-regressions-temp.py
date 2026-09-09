from pathlib import Path

path = Path("scripts/run-regressions.mjs")
text = path.read_text(encoding="utf-8")
replacements = {
    "if (!app.includes('const autoResult = await handleAutoProjectDrop(beat, root.path)')) fail(\"Recognized project files/ZIPs must bypass the redundant role chooser.\");":
        "if (!htmlDropOwner.includes('const autoResult = await handleAutoProjectDrop(beat, root.path)')) fail(\"Recognized project files/ZIPs must bypass the redundant role chooser.\");",
    "if (!controller.includes('onBeatFileStagingChange?.(beatId, true)') || !app.includes('onBeatFileStagingChange: (beatId, active)')) fail(\"Beat-card loading must begin before WebView2 copies/inspects a large PROJECT ZIP.\");":
        "if (!controller.includes('onBeatFileStagingChange?.(beatId, true)') || !htmlDropOwner.includes('onBeatFileStagingChange: (beatId, active)')) fail(\"Beat-card loading must begin before WebView2 copies/inspects a large PROJECT ZIP.\");",
}
for old, new in replacements.items():
    if old not in text:
        raise RuntimeError(f"expected regression ownership guard missing: {old}")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
