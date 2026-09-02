from pathlib import Path

path = Path("scripts/run-regressions.mjs")
text = path.read_text(encoding="utf-8")
old = '  if (!beatCard.includes("if (!playbackInteractive || playbackBlocked) return;")) fail("BeatCard must ignore Play clicks while playback is unavailable or upload/playback preparation is active.");'
new = '  if (!beatCard.includes("if (!playbackInteractive || playbackBlocked) {") || !beatCard.includes("CARD_PLAY_REJECTED") || !beatCard.includes("onPlay(beat);")) fail("BeatCard must ignore Play clicks while playback is unavailable or upload/playback preparation is active.");'
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected exactly one BeatCard playback regression guard, found {count}")
path.write_text(text.replace(old, new), encoding="utf-8")
print("ISSUE97_TRACE_REGRESSION_GUARD_FIXED")
