import fs from 'node:fs';

const path = 'src/app/AppShell.tsx';
let text = fs.readFileSync(path, 'utf8');

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

fs.writeFileSync(path, text);
