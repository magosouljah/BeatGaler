import { readFileSync, writeFileSync } from "node:fs";

const path = "src/App.tsx";
let app = readFileSync(path, "utf8");

function once(oldText, newText, label) {
  const count = app.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly 1 anchor, found ${count}`);
  app = app.replace(oldText, newText);
}

once(
  'import { SearchIcon, PlusIcon, Artwork } from "./components/ui";',
  'import { PlusIcon, Artwork } from "./components/ui";',
  "SearchIcon import"
);
once(
  'import { useTagColors, setTagColor, renameTagColor, TAG_COLOR_PALETTE } from "./lib/tagColors";',
  'import { useTagColors, setTagColor, renameTagColor } from "./lib/tagColors";',
  "TAG_COLOR_PALETTE import"
);
once(
  'import BeatFileDropModal, { type DroppedBeatFileRole } from "./features/dragdrop/components/BeatFileDropModal";',
  'import BeatFileDropModal, { type DroppedBeatFileRole } from "./features/dragdrop/components/BeatFileDropModal";\nimport SearchBar from "./features/library/components/SearchBar";\nimport SortMenu, { type SortKey } from "./features/library/components/SortMenu";\nimport TagColorMenu from "./features/tags/components/TagColorMenu";',
  "feature import anchor"
);

const startMarker = 'type SortKey = "name" | "bpm" | "rating" | "manual";';
const endMarker = '// Local cache so the library paints instantly on next launch instead of';
const start = app.indexOf(startMarker);
const end = app.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error("component block anchors changed");
const removed = app.slice(start, end);
for (const expected of ["function SearchBar(", "function SortMenu(", "function TagColorMenu(", "ReactDOM.createPortal", "TAG_COLOR_PALETTE"]) {
  if (!removed.includes(expected)) throw new Error(`component block missing ${expected}`);
}
app = app.slice(0, start) + app.slice(end);

for (const forbidden of ["function SearchBar(", "function SortMenu(", "function TagColorMenu("]) {
  if (app.includes(forbidden)) throw new Error(`local definition remains: ${forbidden}`);
}
if (!app.includes('useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web")')) throw new Error("web sort routing changed");
if (!app.includes("ReactDOM.createPortal")) throw new Error("App still needs ReactDOM for tag rename dialog");

writeFileSync(path, app);
