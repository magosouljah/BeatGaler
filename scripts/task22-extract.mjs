import { readFileSync, writeFileSync } from "node:fs";
import * as ts from "typescript";

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

const sourceFile = ts.createSourceFile(path, app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wantedFunctions = new Set(["SearchBar", "SortMenu", "TagColorMenu"]);
const removals = [];
let sortKeyFound = false;
const functionsFound = new Set();

for (const statement of sourceFile.statements) {
  if (ts.isTypeAliasDeclaration(statement) && statement.name.text === "SortKey") {
    if (sortKeyFound) throw new Error("duplicate SortKey declaration");
    sortKeyFound = true;
    removals.push({ start: statement.getFullStart(), end: statement.getEnd(), label: "SortKey" });
    continue;
  }
  if (ts.isFunctionDeclaration(statement) && statement.name && wantedFunctions.has(statement.name.text)) {
    if (functionsFound.has(statement.name.text)) throw new Error(`duplicate ${statement.name.text} declaration`);
    functionsFound.add(statement.name.text);
    removals.push({ start: statement.getFullStart(), end: statement.getEnd(), label: statement.name.text });
  }
}

if (!sortKeyFound) throw new Error("SortKey declaration not found");
for (const name of wantedFunctions) {
  if (!functionsFound.has(name)) throw new Error(`${name} declaration not found`);
}
if (removals.length !== 4) throw new Error(`expected 4 removals, found ${removals.length}`);

for (const removal of removals.sort((a, b) => b.start - a.start)) {
  app = app.slice(0, removal.start) + app.slice(removal.end);
}

for (const forbidden of ["function SearchBar(", "function SortMenu(", "function TagColorMenu("]) {
  if (app.includes(forbidden)) throw new Error(`local definition remains: ${forbidden}`);
}
if (!app.includes('useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web")')) throw new Error("web sort routing changed");
if (!app.includes('if (!platform.capabilities.playbackCache) return;')) throw new Error("playback cache guard was removed");
if (!app.includes("Math.min(isTauriAvailable ? 6 : 1, queue.length)")) throw new Error("playback warming concurrency was removed");
if (!app.includes("ReactDOM.createPortal")) throw new Error("App still needs ReactDOM for tag rename dialog");

writeFileSync(path, app);
