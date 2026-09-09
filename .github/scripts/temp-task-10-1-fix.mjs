import fs from 'node:fs';

const shellPath = 'src/app/AppShell.tsx';
let text = fs.readFileSync(shellPath, 'utf8');

const replacements = [
  ['interruptedUploadNotices.map(name =>', 'interruptedUploadNotices.map((name: string) =>'],
  ['displayedBeats.every(b =>', 'displayedBeats.every((b: import("../types").Beat) =>'],
  ['allTags.map(t =>', 'allTags.map((t: string) =>'],
  ['filteredBeats.map((b) => b.id)', 'filteredBeats.map((b: import("../types").Beat) => b.id)'],
  ['filteredBeats.map((beat, i) => (', 'filteredBeats.map((beat: import("../types").Beat, i: number) => ('],
  ['beats.some(existing =>', 'beats.some((existing: import("../types").Beat) =>'],
];

for (const [before, after] of replacements) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one match for ${before}, found ${count}`);
  text = text.replace(before, after);
}

fs.writeFileSync(shellPath, text);

const architecturePath = 'tests/component-dom/startupRevealArchitecture.test.ts';
let architecture = fs.readFileSync(architecturePath, 'utf8');
architecture = architecture.replace(
  'const app = readFileSync("src/App.tsx", "utf8");',
  'const app = readFileSync("src/App.tsx", "utf8");\nconst appShell = readFileSync("src/app/AppShell.tsx", "utf8");',
);
architecture = architecture.replace(
  'expect(app).toContain("<SortableContext items={filteredBeats.map((b) => b.id)}");',
  'expect(appShell).toContain("<SortableContext items={filteredBeats.map(");',
);
for (const assertion of [
  'expect(app).toContain("visible={revealedBeatIds.has(beat.id)}");',
  'expect(app).toContain(\'interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}\');',
  'expect(app).toContain(\'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}\');',
  'expect(app).toContain(\'cloudSessionVerified && connectionState === "online" ? (\');',
]) {
  const count = architecture.split(assertion).length - 1;
  if (count !== 1) throw new Error(`Expected one architecture assertion for ${assertion}, found ${count}`);
  architecture = architecture.replace(assertion, assertion.replace('expect(app)', 'expect(appShell)'));
}
fs.writeFileSync(architecturePath, architecture);

const runtimeFollowupPath = 'tests/integration/issue97RuntimeWebFollowup.test.ts';
let runtimeFollowup = fs.readFileSync(runtimeFollowupPath, 'utf8');
runtimeFollowup = runtimeFollowup.replace(
  '    const app = source("src/App.tsx");\n    const card = source("src/components/BeatCard.tsx");\n    expect(app).toContain(\'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}\');',
  '    const appShell = source("src/app/AppShell.tsx");\n    const card = source("src/components/BeatCard.tsx");\n    expect(appShell).toContain(\'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}\');',
);
fs.writeFileSync(runtimeFollowupPath, runtimeFollowup);
