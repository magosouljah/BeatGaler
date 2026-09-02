from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")

# App cache comment now reflects instant-paint behavior.
replace_once(
    "src/App.tsx",
    '''  // Browser/localStorage library data is only an instant-paint helper AFTER the\n  // cloud/offline source has been verified. Never render it as a cold-start\n  // library by itself: navigator.onLine and a localhost SSE connection can both\n  // look healthy while Telegram is actually unreachable.\n''',
    '''  // Browser/localStorage library data is an instant-paint presentation cache.\n  // It may render before cloud authority resolves, but remains read-only until\n  // verification and is never allowed to overwrite the authoritative library.\n''',
)

# Do not reveal metadata-only Desktop entries as fallback before their thumbnail
# cache has had a chance to hydrate them.
replace_once(
    "src/App.tsx",
    '''    (startupCachedBeatsRef.current ?? [])\n      .filter(beat => Boolean(beat.image_preview_base64 || beat.image_base64) || !beat.assets?.artwork?.object_id)\n      .map(beat => beat.id)\n''',
    '''    (startupCachedBeatsRef.current ?? [])\n      .filter(beat => Boolean(beat.image_preview_base64 || beat.image_base64))\n      .map(beat => beat.id)\n''',
)

# Cached cards are presentation-only until authority has resolved. Offline/poor
# lists are already replaced by showOfflineLibrary with validated durable pins.
replace_once(
    "src/App.tsx",
    '''                    beat={beat}\n                    visible={revealedBeatIds.has(beat.id)}\n''',
    '''                    beat={beat}\n                    visible={revealedBeatIds.has(beat.id)}\n                    interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}\n''',
)

# BeatCard separates visual reveal from interaction/readiness.
replace_once(
    "src/components/BeatCard.tsx",
    '''  beat: Beat;\n  visible?: boolean;\n''',
    '''  beat: Beat;\n  visible?: boolean;\n  interactive?: boolean;\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''  beat, visible = true, cloudUploadErrorDetail, tagFrequency, showIncompleteWarnings, openableProject = false, playing, selected, selectedCount, selectMode,\n''',
    '''  beat, visible = true, interactive = true, cloudUploadErrorDetail, tagFrequency, showIncompleteWarnings, openableProject = false, playing, selected, selectedCount, selectMode,\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''  } = useSortable({ id: beat.id, disabled: !dragEnabled || !visible });\n''',
    '''  } = useSortable({ id: beat.id, disabled: !dragEnabled || !visible || !interactive });\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''    if (!visible || !node || hasEnteredViewport) return;\n''',
    '''    if (!visible || !interactive || !node || hasEnteredViewport) return;\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''  }, [visible, hasEnteredViewport]);\n\n  useEffect(() => {\n    if (!visible || !hasEnteredViewport || !beat.telegram_file_id) return;\n''',
    '''  }, [visible, interactive, hasEnteredViewport]);\n\n  useEffect(() => {\n    if (!visible || !interactive || !hasEnteredViewport || !beat.telegram_file_id) return;\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''  }, [visible, hasEnteredViewport, beat.id, beat.telegram_file_id, onWarm]);\n''',
    '''  }, [visible, interactive, hasEnteredViewport, beat.id, beat.telegram_file_id, onWarm]);\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''    if (!visible || !hasEnteredViewport) return;\n''',
    '''    if (!visible || !interactive || !hasEnteredViewport) return;\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''  }, [visible, hasEnteredViewport, beat.id, beat.flp_path, beat.folder_path, beat.cloud_status, canInspectNativeProject]);\n''',
    '''  }, [visible, interactive, hasEnteredViewport, beat.id, beat.flp_path, beat.folder_path, beat.cloud_status, canInspectNativeProject]);\n''',
)
replace_once(
    "src/components/BeatCard.tsx",
    '''        cursor: visible && selectMode ? "pointer" : "default",\n        visibility: visible ? "visible" : "hidden",\n        pointerEvents: visible ? "auto" : "none",\n''',
    '''        cursor: visible && interactive && selectMode ? "pointer" : "default",\n        visibility: visible ? "visible" : "hidden",\n        pointerEvents: visible && interactive ? "auto" : "none",\n''',
)

# Web has durable object IDs; Desktop/local entries use a stable per-beat key.
replace_once(
    "src/features/artwork/artworkThumbnailCache.ts",
    '''export function artworkThumbnailCacheKey(beat: ArtworkIdentity): string | null {\n  const objectId = beat.assets?.artwork?.object_id?.trim();\n  if (!objectId) return null;\n  return `${beat.id}:${objectId}`;\n}\n''',
    '''export function artworkThumbnailCacheKey(beat: ArtworkIdentity): string {\n  const objectId = beat.assets?.artwork?.object_id?.trim();\n  return objectId ? `${beat.id}:${objectId}` : `${beat.id}:local`;\n}\n''',
)
replace_once(
    "src/features/artwork/artworkThumbnailCache.ts",
    '''  if (!key || !cacheSupported()) return null;\n''',
    '''  if (!cacheSupported()) return null;\n''',
)
replace_once(
    "src/features/artwork/artworkThumbnailCache.ts",
    '''  if (!key || !cacheSupported()) return source;\n''',
    '''  if (!cacheSupported()) return source;\n''',
)

# Update thumbnail contract test for Desktop/local fallback key.
replace_once(
    "tests/component-dom/artworkThumbnailCache.test.ts",
    '''  it("does not invent a cache identity when the beat has no durable artwork reference", () => {\n    expect(artworkThumbnailCacheKey({ id: "beat-1", assets: undefined } as any)).toBeNull();\n  });\n''',
    '''  it("uses a stable local key when Desktop has no cloud artwork object id", () => {\n    expect(artworkThumbnailCacheKey({ id: "beat-1", assets: undefined } as any)).toBe("beat-1:local");\n  });\n''',
)

replace_once(
    "tests/component-dom/startupRevealArchitecture.test.ts",
    '''    expect(app).toContain("visible={revealedBeatIds.has(beat.id)}");\n    expect(beatCard).toContain('visibility: visible ? "visible" : "hidden"');\n''',
    '''    expect(app).toContain("visible={revealedBeatIds.has(beat.id)}");\n    expect(app).toContain('interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}');\n    expect(beatCard).toContain('visibility: visible ? "visible" : "hidden"');\n    expect(beatCard).toContain('pointerEvents: visible && interactive ? "auto" : "none"');\n''',
)
replace_once(
    "tests/component-dom/startupRevealArchitecture.test.ts",
    '''    expect(beatCard).toContain("if (!visible || !hasEnteredViewport || !beat.telegram_file_id) return;");\n''',
    '''    expect(beatCard).toContain("if (!visible || !interactive || !hasEnteredViewport || !beat.telegram_file_id) return;");\n''',
)

print("Issue #97 hardening patch applied")
