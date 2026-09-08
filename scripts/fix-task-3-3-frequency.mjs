import { readFileSync, writeFileSync } from "node:fs";

const path = "src/App.tsx";
let app = readFileSync(path, "utf8");

const importBefore = 'import { selectAllTags, selectTagSuggestions } from "./features/tags/tagSelectors";';
const importAfter = 'import { selectAllTags, selectTagFrequency, selectTagSuggestions } from "./features/tags/tagSelectors";';
if (!app.includes(importBefore)) throw new Error("Task 3.3 frequency patch: tag selector import missing");
app = app.replace(importBefore, importAfter);

const derivedBefore = '  const allTags = useMemo(() => selectAllTags(beats), [beats]);\n  const tagSuggestions = useMemo(() => selectTagSuggestions(beats), [beats]);';
const derivedAfter = '  const tagFrequency = useMemo(() => selectTagFrequency(beats), [beats]);\n  const allTags = useMemo(() => selectAllTags(beats, tagFrequency), [beats, tagFrequency]);\n  const tagSuggestions = useMemo(() => selectTagSuggestions(beats), [beats]);';
if (!app.includes(derivedBefore)) throw new Error("Task 3.3 frequency patch: derived selector block missing");
app = app.replace(derivedBefore, derivedAfter);

writeFileSync(path, app);
console.log("Task 3.3 tagFrequency consumer preserved through extracted selector.");
