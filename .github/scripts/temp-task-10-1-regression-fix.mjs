import fs from 'node:fs';

const path = 'scripts/run-regressions.mjs';
let source = fs.readFileSync(path, 'utf8');
const patches = [
  [
    "if (!app.includes('interactive={cloudSessionVerified || connectionState === \"offline\" || connectionState === \"poor\"}')) fail(\"Cached cloud presentation can become interactive before authority verification.\");",
    "if (!appShell.includes('interactive={cloudSessionVerified || connectionState === \"offline\" || connectionState === \"poor\"}')) fail(\"Cached cloud presentation can become interactive before authority verification.\");",
  ],
  [
    "if (!app.includes('playbackInteractive={connectionState !== \"offline\" || Boolean(beat.offline_available)}')) fail(\"Cached cards lost the non-destructive playback gate while cloud authority is verifying.\");",
    "if (!appShell.includes('playbackInteractive={connectionState !== \"offline\" || Boolean(beat.offline_available)}')) fail(\"Cached cards lost the non-destructive playback gate while cloud authority is verifying.\");",
  ],
];
for (const [before, after] of patches) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one regression guard match, found ${count}: ${before}`);
  source = source.replace(before, after);
}
fs.writeFileSync(path, source);
