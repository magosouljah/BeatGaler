'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath = 'src/App.tsx';
const source = fs.readFileSync(sourcePath, 'utf8');
const functionMarker = 'function BeatGalerApp() {';
const appMarker = '\n\nexport default function App() {';

if (!source.includes(functionMarker) || !source.includes(appMarker)) {
  throw new Error('App.tsx no longer matches the validated 10.1 composition shape');
}

const functionStart = source.indexOf(functionMarker);
const appStart = source.lastIndexOf(appMarker);
let prefix = source.slice(0, functionStart);
let compositionFunction = source.slice(functionStart, appStart).trimEnd();

prefix = prefix
  .replace(/from "\.\//g, 'from "../')
  .replace('import AccountGate, { logoutBeatGalerAccount } from "../components/AccountGate";', 'import { logoutBeatGalerAccount } from "../components/AccountGate";')
  .replace('import AppShell from "../app/AppShell";\n', '')
  .replace('import { useAppShortcuts } from "../app/useAppShortcuts";', 'import { useAppShortcuts } from "./useAppShortcuts";');

compositionFunction = compositionFunction
  .replace(functionMarker, 'export function useBeatGalerComposition() {')
  .replace(/import\("\.\//g, 'import("../');

const returnStart = '  return <AppShell scope={{';
const returnEnd = '}} />;';
const returnStartIndex = compositionFunction.lastIndexOf(returnStart);
const returnEndIndex = compositionFunction.lastIndexOf(returnEnd);
if (returnStartIndex < 0 || returnEndIndex < returnStartIndex) {
  throw new Error('Could not locate AppShell composition return');
}

compositionFunction =
  compositionFunction.slice(0, returnStartIndex) +
  '  return {' +
  compositionFunction.slice(returnStartIndex + returnStart.length, returnEndIndex) +
  '};' +
  compositionFunction.slice(returnEndIndex + returnEnd.length);

const composition = `${prefix}${compositionFunction}\n`;
fs.writeFileSync('src/app/useBeatGalerComposition.ts', composition);

fs.writeFileSync('src/app/BeatGalerApp.tsx', `import React from "react";\nimport AccountGate from "../components/AccountGate";\nimport { platform } from "../platform";\nimport AppShell from "./AppShell";\nimport { useBeatGalerComposition } from "./useBeatGalerComposition";\n\nfunction BeatGalerWorkspace() {\n  const scope = useBeatGalerComposition();\n  return <AppShell scope={scope} />;\n}\n\nexport default function BeatGalerApp() {\n  return platform.kind === "web"\n    ? <BeatGalerWorkspace />\n    : <AccountGate><BeatGalerWorkspace /></AccountGate>;\n}\n`);

fs.writeFileSync(sourcePath, `import React from "react";\nimport BeatGalerApp from "./app/BeatGalerApp";\n\nexport default function App() {\n  return <BeatGalerApp />;\n}\n`);

const shellTestPath = 'tests/component-dom/appShellExtraction.test.ts';
let shellTest = fs.readFileSync(shellTestPath, 'utf8');
shellTest = shellTest
  .replace('const shell = readFileSync("src/app/AppShell.tsx", "utf8");', 'const beatGalerApp = readFileSync("src/app/BeatGalerApp.tsx", "utf8");\nconst composition = readFileSync("src/app/useBeatGalerComposition.ts", "utf8");\nconst shell = readFileSync("src/app/AppShell.tsx", "utf8");')
  .replace('expect(app).toContain("<AppShell scope={{");', 'expect(beatGalerApp).toContain("<AppShell scope={scope} />");')
  .replace('expect(app).toContain("useAppShortcuts({");', 'expect(composition).toContain("useAppShortcuts({");')
  .replace('expect(app).toContain("usePublishingActions({");', 'expect(composition).toContain("usePublishingActions({");');
fs.writeFileSync(shellTestPath, shellTest);

const startupTestPath = 'tests/component-dom/startupRevealArchitecture.test.ts';
let startupTest = fs.readFileSync(startupTestPath, 'utf8');
startupTest = startupTest
  .replace('const app = readFileSync("src/App.tsx", "utf8");', 'const app = readFileSync("src/App.tsx", "utf8");\nconst beatGalerApp = readFileSync("src/app/BeatGalerApp.tsx", "utf8");\nconst composition = readFileSync("src/app/useBeatGalerComposition.ts", "utf8");')
  .replace('expect(app).toContain("} = useLibraryState();");', 'expect(composition).toContain("} = useLibraryState();");')
  .replace('expect(app).toContain("useLibraryPresentationCache(");', 'expect(composition).toContain("useLibraryPresentationCache(");')
  .replace('expect(app).not.toContain("After the first six are usable, prepare the rest one at a time");', 'expect(composition).not.toContain("After the first six are usable, prepare the rest one at a time");')
  .replace('expect(app).toContain(\'return platform.kind === "web"\');', 'expect(beatGalerApp).toContain(\'return platform.kind === "web"\');')
  .replace('expect(app).toContain(\'? <BeatGalerApp />\');', 'expect(beatGalerApp).toContain(\'? <BeatGalerWorkspace />\');')
  .replace('expect(app).toContain(\': <AccountGate><BeatGalerApp /></AccountGate>\');', 'expect(beatGalerApp).toContain(\': <AccountGate><BeatGalerWorkspace /></AccountGate>\');');
fs.writeFileSync(startupTestPath, startupTest);

fs.writeFileSync('tests/component-dom/appComposition.test.ts', `import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\nconst app = readFileSync("src/App.tsx", "utf8");\nconst beatGalerApp = readFileSync("src/app/BeatGalerApp.tsx", "utf8");\nconst composition = readFileSync("src/app/useBeatGalerComposition.ts", "utf8");\n\ndescribe("minimal application composition", () => {\n  it("keeps App as a tiny entry point", () => {\n    const lines = app.trimEnd().split(/\\r?\\n/).length;\n    expect(lines).toBeGreaterThanOrEqual(5);\n    expect(lines).toBeLessThanOrEqual(15);\n    expect(app).toContain("<BeatGalerApp />");\n    expect(app).not.toContain("AccountGate");\n    expect(app).not.toContain("platform.kind");\n    expect(app).not.toContain("AppShell");\n  });\n\n  it("keeps the single platform authentication route in BeatGalerApp", () => {\n    expect(beatGalerApp).toContain('platform.kind === "web"');\n    expect(beatGalerApp).toContain("<BeatGalerWorkspace />");\n    expect(beatGalerApp).toContain("<AccountGate><BeatGalerWorkspace /></AccountGate>");\n    expect(beatGalerApp).toContain("<AppShell scope={scope} />");\n  });\n\n  it("keeps feature wiring in the composition boundary without hiding a legacy app component", () => {\n    expect(composition).toContain("export function useBeatGalerComposition()");\n    expect(composition).toContain("useLibraryState()");\n    expect(composition).toContain("usePlaybackController({");\n    expect(composition).toContain("useCloudUploadQueue({");\n    expect(composition).toContain("useAppShortcuts({");\n    expect(composition).not.toContain("BeatGalerCompositionLegacy");\n    expect(composition).not.toContain("<AppShell");\n  });\n});\n`);

const integrationDir = 'tests/integration';
const oldResolvedDouble = 'readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8")';
const newResolvedDouble = 'readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8").replaceAll("../", "./")';
const oldResolvedSingle = "readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')";
const newResolvedSingle = "readFileSync(resolve(process.cwd(), 'src/app/useBeatGalerComposition.ts'), 'utf8').replaceAll('../', './')";
const oldDirectDouble = 'readFileSync("src/App.tsx", "utf8")';
const newDirectDouble = 'readFileSync("src/app/useBeatGalerComposition.ts", "utf8").replaceAll("../", "./")';
const oldDirectSingle = "readFileSync('src/App.tsx', 'utf8')";
const newDirectSingle = "readFileSync('src/app/useBeatGalerComposition.ts', 'utf8').replaceAll('../', './')";
let updatedIntegrationFiles = 0;

for (const name of fs.readdirSync(integrationDir)) {
  if (!name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) continue;
  const testPath = path.join(integrationDir, name);
  let text = fs.readFileSync(testPath, 'utf8');
  const before = text;
  text = text
    .replaceAll(oldResolvedDouble, newResolvedDouble)
    .replaceAll(oldResolvedSingle, newResolvedSingle)
    .replaceAll(oldDirectDouble, newDirectDouble)
    .replaceAll(oldDirectSingle, newDirectSingle);
  if (text !== before) {
    fs.writeFileSync(testPath, text);
    updatedIntegrationFiles += 1;
  }
}

if (updatedIntegrationFiles === 0) {
  throw new Error('No integration characterization files were redirected from App.tsx');
}
console.log(`Updated ${updatedIntegrationFiles} integration characterization files for the 10.2 composition boundary`);

for (const tempPath of [
  '.github/workflows/task-10-2-composition-temp.yml',
  '.github/workflows/task-10-2-integration-fix-temp.yml',
  'scripts/task-10-2-refactor-temp.cjs',
]) {
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
