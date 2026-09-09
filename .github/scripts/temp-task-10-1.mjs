import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const appPath = 'src/App.tsx';
let app = fs.readFileSync(appPath, 'utf8');

function replaceOnce(text, oldValue, newValue, label) {
  const count = text.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return text.replace(oldValue, newValue);
}

// 10.1: publishing owns the YouTube modal/open callbacks.
app = replaceOnce(
  app,
  '  const [showUpload, setShowUpload] = useState<{ initialBeat: Beat | null; selectedIds?: string[] } | null>(null);\n',
  '',
  'showUpload state',
);

const uploadStart = app.indexOf('  const handleUpload = useCallback((beat: Beat) => {');
const uploadEndMarker = '  }, [rejectOfflineMutation]);\n';
if (uploadStart < 0) throw new Error('handleUpload start not found');
const uploadEnd = app.indexOf(uploadEndMarker, uploadStart);
if (uploadEnd < 0) throw new Error('handleUpload end not found');
app = app.slice(0, uploadStart) + app.slice(uploadEnd + uploadEndMarker.length);

const bulkStart = app.indexOf('  const handleUploadBulk = useCallback(() => {');
const bulkEndMarker = '  }, [selectedIds, rejectOfflineMutation]);\n';
if (bulkStart < 0) throw new Error('handleUploadBulk start not found');
const bulkEnd = app.indexOf(bulkEndMarker, bulkStart);
if (bulkEnd < 0) throw new Error('handleUploadBulk end not found');
app = app.slice(0, bulkStart) + app.slice(bulkEnd + bulkEndMarker.length);

const rejectAnchor = '  }, [connectionState]);\n\n';
const rejectPos = app.indexOf(rejectAnchor, app.indexOf('const rejectOfflineMutation'));
if (rejectPos < 0) throw new Error('rejectOfflineMutation anchor not found');
const publishingCall = '  const { showUpload, setShowUpload, handleUpload, handleUploadBulk } = usePublishingActions({\n    selectedIds,\n    rejectOfflineMutation,\n  });\n\n';
app = app.slice(0, rejectPos + rejectAnchor.length) + publishingCall + app.slice(rejectPos + rejectAnchor.length);

// 10.1: global shortcuts leave App.
const shortcutsStart = app.indexOf('  // Global keyboard shortcuts — stable handler via ref\n');
const shortcutsEndMarker = '  }, []); // empty deps — safe because we use ref\n\n';
if (shortcutsStart < 0) throw new Error('shortcuts start not found');
const shortcutsEnd = app.indexOf(shortcutsEndMarker, shortcutsStart);
if (shortcutsEnd < 0) throw new Error('shortcuts end not found');
app = app.slice(0, shortcutsStart) + app.slice(shortcutsEnd + shortcutsEndMarker.length);

const queueStart = app.indexOf('  } = usePlaybackQueue({');
if (queueStart < 0) throw new Error('usePlaybackQueue start not found');
const queueEndMarker = '  });\n';
const queueEnd = app.indexOf(queueEndMarker, queueStart);
if (queueEnd < 0) throw new Error('usePlaybackQueue end not found');
const shortcutsCall = '\n  useAppShortcuts({\n    togglePauseRef,\n    clearSelection,\n    setDrawer,\n    setShowAdd,\n    setShowSettings,\n    closeQueue,\n    setShowUpload,\n  });\n';
app = app.slice(0, queueEnd + queueEndMarker.length) + shortcutsCall + app.slice(queueEnd + queueEndMarker.length);

// Add extracted-owner imports.
const importAnchor = 'import { useCloudLibraryEvents } from "./features/cloud/useCloudLibraryEvents";\n';
const ownerImports = 'import AppShell from "./app/AppShell";\nimport { useAppShortcuts } from "./app/useAppShortcuts";\nimport { usePublishingActions } from "./features/publishing/usePublishingActions";\n';
app = replaceOnce(app, importAnchor, importAnchor + ownerImports, 'owner import anchor');

// Parse the patched App and extract its single top-level UI return.
let sf = ts.createSourceFile(appPath, app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let beatGalerApp;
for (const statement of sf.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'BeatGalerApp') beatGalerApp = statement;
}
if (!beatGalerApp?.body) throw new Error('BeatGalerApp not found');
const returnStmt = beatGalerApp.body.statements.find(ts.isReturnStatement);
if (!returnStmt?.expression) throw new Error('BeatGalerApp top-level return not found');
const expression = returnStmt.expression;

const importsByBinding = new Map();
for (const statement of sf.statements) {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
  const bindings = [];
  if (statement.importClause.name) bindings.push(statement.importClause.name.text);
  const named = statement.importClause.namedBindings;
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) bindings.push(element.name.text);
  } else if (named && ts.isNamespaceImport(named)) {
    bindings.push(named.name.text);
  }
  const text = app.slice(statement.getStart(sf), statement.getEnd());
  for (const binding of bindings) importsByBinding.set(binding, text);
}

const localNames = new Set();
function addBindingName(name) {
  if (ts.isIdentifier(name)) localNames.add(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) if (ts.isBindingElement(element)) addBindingName(element.name);
  }
}
function collectLocals(node) {
  if (ts.isParameter(node)) addBindingName(node.name);
  if (ts.isVariableDeclaration(node)) addBindingName(node.name);
  if (ts.isFunctionDeclaration(node) && node.name) localNames.add(node.name.text);
  if (ts.isFunctionExpression(node) && node.name) localNames.add(node.name.text);
  ts.forEachChild(node, collectLocals);
}
collectLocals(expression);

function isDeclarationIdentifier(node) {
  const p = node.parent;
  return (ts.isParameter(p) && p.name === node)
    || (ts.isVariableDeclaration(p) && p.name === node)
    || (ts.isBindingElement(p) && p.name === node)
    || (ts.isPropertyAccessExpression(p) && p.name === node)
    || (ts.isPropertyAssignment(p) && p.name === node && !ts.isComputedPropertyName(p.name))
    || (ts.isMethodDeclaration(p) && p.name === node)
    || (ts.isJsxAttribute(p) && p.name === node)
    || ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node && /^[a-z]/.test(node.text));
}

const globals = new Set([
  'window','document','console','Math','Array','Object','String','Number','Boolean','Set','Map','Promise','Error','undefined','null','true','false',
]);
const used = new Set();
function collectUsed(node) {
  if (ts.isIdentifier(node) && !isDeclarationIdentifier(node) && !localNames.has(node.text) && !globals.has(node.text)) {
    used.add(node.text);
  }
  ts.forEachChild(node, collectUsed);
}
collectUsed(expression);

const shellImports = [];
const props = [];
for (const name of [...used].sort()) {
  const importText = importsByBinding.get(name);
  if (importText) shellImports.push(importText);
  else props.push(name);
}
const uniqueImports = [...new Set(shellImports)].map(text => text.replace(/from "\.\//g, 'from "../'));
const expressionText = app.slice(expression.getStart(sf), expression.getEnd());

fs.mkdirSync('src/app', { recursive: true });
const shell = `${uniqueImports.join('\n')}\n\nexport default function AppShell({ scope }: { scope: Record<string, any> }) {\n  const { ${props.join(', ')} } = scope;\n  return ${expressionText};\n}\n`;
fs.writeFileSync('src/app/AppShell.tsx', shell);

const replacement = `<AppShell scope={{ ${props.join(', ')} }} />`;
app = app.slice(0, expression.getStart(sf)) + replacement + app.slice(expression.getEnd());
fs.writeFileSync(appPath, app);

fs.writeFileSync('src/app/useAppShortcuts.ts', `import { useEffect } from "react";\nimport type { MutableRefObject } from "react";\n\ntype AppShortcutsOptions = {\n  togglePauseRef: MutableRefObject<() => void>;\n  clearSelection: () => void;\n  setDrawer: (value: null) => void;\n  setShowAdd: (value: boolean) => void;\n  setShowSettings: (value: boolean) => void;\n  closeQueue: () => void;\n  setShowUpload: (value: null) => void;\n};\n\nexport function useAppShortcuts(options: AppShortcutsOptions) {\n  useEffect(() => {\n    const handler = (e: KeyboardEvent) => {\n      const tag = (e.target as HTMLElement).tagName;\n      const isTyping = tag === "INPUT" || tag === "TEXTAREA";\n      if (e.key === "Escape") {\n        (document.activeElement as HTMLElement | null)?.blur();\n        window.getSelection()?.removeAllRanges();\n        options.clearSelection();\n        options.setDrawer(null);\n        options.setShowAdd(false);\n        options.setShowSettings(false);\n        options.closeQueue();\n        options.setShowUpload(null);\n      }\n      if (e.key === " " && !isTyping) {\n        e.preventDefault();\n        options.togglePauseRef.current();\n      }\n    };\n    window.addEventListener("keydown", handler);\n    return () => window.removeEventListener("keydown", handler);\n  }, []);\n}\n`);

fs.mkdirSync('src/features/publishing', { recursive: true });
fs.writeFileSync('src/features/publishing/usePublishingActions.ts', `import { useCallback, useState } from "react";\nimport type { Beat } from "../../types";\n\ntype UploadState = { initialBeat: Beat | null; selectedIds?: string[] } | null;\n\ntype PublishingActionsOptions = {\n  selectedIds: ReadonlySet<string>;\n  rejectOfflineMutation: (action: string) => boolean;\n};\n\nexport function usePublishingActions({ selectedIds, rejectOfflineMutation }: PublishingActionsOptions) {\n  const [showUpload, setShowUpload] = useState<UploadState>(null);\n\n  const handleUpload = useCallback((beat: Beat) => {\n    if (rejectOfflineMutation("Uploading to YouTube")) return;\n    setShowUpload({ initialBeat: beat, selectedIds: undefined });\n  }, [rejectOfflineMutation]);\n\n  const handleUploadBulk = useCallback(() => {\n    if (rejectOfflineMutation("Bulk upload")) return;\n    setShowUpload({ initialBeat: null, selectedIds: Array.from(selectedIds) });\n  }, [selectedIds, rejectOfflineMutation]);\n\n  return { showUpload, setShowUpload, handleUpload, handleUploadBulk };\n}\n`);

// Focused architecture characterization for 10.1. It intentionally checks ownership,
// not implementation details inside the extracted UI blocks.
fs.mkdirSync('tests/component-dom', { recursive: true });
fs.writeFileSync('tests/component-dom/appShellExtraction.test.ts', `import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\nconst app = readFileSync("src/App.tsx", "utf8");\nconst shell = readFileSync("src/app/AppShell.tsx", "utf8");\nconst shortcuts = readFileSync("src/app/useAppShortcuts.ts", "utf8");\nconst publishing = readFileSync("src/features/publishing/usePublishingActions.ts", "utf8");\n\ndescribe("App visual shell extraction", () => {\n  it("moves the large visual regions out of App", () => {\n    expect(app).toContain("<AppShell scope={{");\n    expect(app).not.toContain("{/* Top bar */}");\n    expect(app).not.toContain("{/* Selection toolbar */}");\n    expect(app).not.toContain("{/* Grid — OS file drag-drop */}");\n    expect(shell).toContain("{/* Top bar */}");\n    expect(shell).toContain("{/* Selection toolbar */}");\n    expect(shell).toContain("{/* Grid — OS file drag-drop */}");\n    expect(shell).toContain("<Player");\n    expect(shell).toContain("<ImportReviewHost");\n    expect(shell).toContain("<JobStatusBar />");\n  });\n\n  it("moves shortcuts and YouTube opening to dedicated owners", () => {\n    expect(app).toContain("useAppShortcuts({");\n    expect(app).toContain("usePublishingActions({");\n    expect(app).not.toContain("window.addEventListener(\\\"keydown\\\"");\n    expect(shortcuts).toContain("window.addEventListener(\\\"keydown\\\"");\n    expect(publishing).toContain("Uploading to YouTube");\n    expect(publishing).toContain("Bulk upload");\n  });\n});\n`);

console.log(`task 10.1 extraction generated with ${props.length} shell props and ${uniqueImports.length} shell imports`);
