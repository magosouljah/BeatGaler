import fs from 'node:fs';

const componentPath = 'tests/component-dom/artworkHydration.test.tsx';
let component = fs.readFileSync(componentPath, 'utf8');
const oldMocks = `const loadArtwork = vi.fn();\nconst cacheArtworkThumbnail = vi.fn();\nconst readCachedArtworkThumbnail = vi.fn();\nconst decodeArtworkDataUrl = vi.fn();\n`;
const newMocks = `const { loadArtwork, cacheArtworkThumbnail, readCachedArtworkThumbnail, decodeArtworkDataUrl } = vi.hoisted(() => ({\n  loadArtwork: vi.fn(),\n  cacheArtworkThumbnail: vi.fn(),\n  readCachedArtworkThumbnail: vi.fn(),\n  decodeArtworkDataUrl: vi.fn(),\n}));\n`;
if (!component.includes(oldMocks)) throw new Error('Expected artwork test mocks not found');
component = component.replace(oldMocks, newMocks);
fs.writeFileSync(componentPath, component);

const helperPath = 'tests/integration/appHelperExtraction.test.ts';
let helper = fs.readFileSync(helperPath, 'utf8');
const decodeImportLine = '      "./features/artwork/decodeArtworkDataUrl",\n';
if (!helper.includes(decodeImportLine)) throw new Error('Legacy direct artwork decoder import assertion not found');
helper = helper.replace(decodeImportLine, '');
const artworkReadAnchor = 'const artworkDecode = readFileSync(resolve(root, "src/features/artwork/decodeArtworkDataUrl.ts"), "utf8");\n';
if (!helper.includes(artworkReadAnchor)) throw new Error('Artwork decoder read anchor not found');
helper = helper.replace(artworkReadAnchor, artworkReadAnchor + 'const artworkHydration = readFileSync(resolve(root, "src/features/artwork/useArtworkHydration.ts"), "utf8");\n');
const ownershipAnchor = '    for (const localDefinition of [\n';
if (!helper.includes(ownershipAnchor)) throw new Error('Helper ownership anchor not found');
helper = helper.replace(ownershipAnchor, '    expect(artworkHydration).toContain(\'from "./decodeArtworkDataUrl"\');\n\n' + ownershipAnchor);
fs.writeFileSync(helperPath, helper);

console.log('Task 4.1 test ownership patched');
