// trace-files.mjs <repo> [list]
// "Files a reader must open to follow one request end to end" for 3 fixed scenarios.
// Each hop is [file, anchor]: the hop is only counted if the file exists AND contains the anchor string that proves
// it takes part in the path at this SHA. The lists were derived by static reading/grep at 3f009a7 (no runtime trace),
// so they are LOWER BOUNDS: generic interposers that do not name the route are included only where an anchor shows
// they wrap every request. After a refactor: hops whose anchor disappeared are reported as STALE -> re-derive.
// Read-only.
import { pathToFileURL } from "node:url";
import { repoArg, tracked, read, lines, head } from './lib.mjs';
const SC = {
  'A  POST /auth/login (Web form -> session)': [
    ['src/features/auth/webSession.ts', '/auth/login'],
    ['src/features/auth/webFetchBoundary.ts', 'window.fetch ='],
    ['src/features/auth/webCsrfFetchCoordinator.ts', 'function createWebCsrfCoordinatedFetch'],
    ['cloud-server/server.js', 'require("./server-core")'],
    ['cloud-server/server-core-auth-bridge-loader.js', 'installServerCoreAuthBridgeLoader'],
    ['cloud-server/runtime-operability.js', 'function wrapRuntimeUse'],
    ['cloud-server/security-headers.js', 'function wrapSecurityHeadersUse'],
    ['cloud-server/http-containment.js', '/auth/login'],
    ['cloud-server/auth-abuse-controls.js', '/auth/login'],
    ['cloud-server/auth-durable-abuse-controls.js', '/auth/login'],
    ['cloud-server/auth-public-registration-hardening.js', '/auth/login'],
    ['cloud-server/pending-signup-boundary.js', 'function wrapPendingSignupPost'],
    ['cloud-server/session-security.js', '/auth/login'],
    ['cloud-server/account-lifecycle.js', '/auth/login'],
    ['cloud-server/server-core.js', 'app.post("/auth/login"'],
    ['cloud-server/stage1-critical-path-trace.js', '/auth/login'],
    ['cloud-server/password-kdf.js', 'verifyPassword'],
    ['cloud-server/user-storage-lifecycle.js', 'createUserStorageLifecycle'],
    ['cloud-server/access-consumer-handlers.js', 'accountPublicPayload'],
    ['cloud-server/control-plane-json-compat.js', 'response.send = function'],
  ],
  'B  Edit a beat\'s metadata (Drawer Save -> SQL UPDATE)': [
    ['src/components/Drawer.tsx', 'onWebSave'],
    ['src/features/library/catalog/CatalogAppShell.tsx', 'scope.saveWebDrawer'],
    ['src/features/library/catalog/useCatalogGalleryScope.ts', 'saveDrawerToCatalog'],
    ['src/features/library/catalog/catalogBeatEditor.ts', 'mutations.patchBeat'],
    ['src/features/library/catalog/catalogMutations.ts', 'async function patchBeat'],
    ['src/features/library/catalog/catalogCommandsApi.ts', 'patchBeat:'],
    ['src/features/library/catalog/catalogHttp.ts', 'fetch'],
    ['src/features/auth/webFetchBoundary.ts', 'window.fetch ='],
    ['src/features/auth/webCsrfFetchCoordinator.ts', 'function createWebCsrfCoordinatedFetch'],
    ['cloud-server/server.js', 'assembleServerCatalog'],
    ['cloud-server/catalog-assembly.js', 'catalogCommands'],
    ['cloud-server/server-core.js', 'mountCatalog'],
    ['cloud-server/catalog-boot.js', 'createCatalogRouter'],
    ['cloud-server/session-security.js', 'function wrapSessionSecurityUse'],
    ['cloud-server/http-containment.js', 'function wrapHttpContainmentPost'],
    ['cloud-server/catalog/routes.js', '/beats/:id`'],
    ['cloud-server/catalog/authority.js', 'createCatalogAuthority'],
    ['cloud-server/catalog/commands.js', 'libraryTx.mutate'],
    ['cloud-server/catalog/library-tx.js', 'async function mutationTx'],
    ['cloud-server/catalog/metadata-rules.js', ''],
    ['cloud-server/catalog/beat-projection.js', 'PATCH_SQL'],
    ['cloud-server/catalog/facets.js', ''],
  ],
  'C  Upload a beat (Add beat -> Direct B -> worker commit)': [
    ['src/components/AddBeatModal.tsx', 'onAdd'],
    ['src/features/library/catalog/CatalogAppShell.tsx', 'scope.addBeatsAndReview'],
    ['src/features/library/catalog/useCatalogGalleryScope.ts', 'saveReview'],
    ['src/features/library/catalog/catalogImportSession.ts', 'mutations.importBeat'],
    ['src/features/library/catalog/catalogImportPlan.ts', 'resolveImportPlan'],
    ['src/features/library/catalog/catalogFilePrep.ts', ''],
    ['src/features/library/catalog/catalogMainPack.ts', ''],
    ['src/features/library/catalog/catalogMutations.ts', 'async function importBeat'],
    ['src/features/library/catalog/catalogTransfer.ts', './catalogDirectCore'],
    ['src/features/library/catalog/catalogCommandsApi.ts', ''],
    ['src/features/library/catalog/catalogHttp.ts', 'fetch'],
    ['src/features/library/catalog/catalogDirectPort.ts', 'webTransportWorkerClient'],
    ['src/features/library/catalog/catalogDirectCore.ts', ''],
    ['src/features/library/catalog/catalogUploadProgress.ts', ''],
    ['src/features/cloud/webTransportWorkerClient.ts', 'Worker'],
    ['src/features/cloud/webTransportController.ts', ''],
    ['src/features/cloud/webTransportSession.ts', ''],
    ['src/features/cloud/webTransportWorkerProtocol.ts', ''],
    ['src/features/cloud/webTransport.worker.ts', ''],
    ['src/features/auth/webFetchBoundary.ts', 'window.fetch ='],
    ['src/features/auth/webCsrfFetchCoordinator.ts', 'function createWebCsrfCoordinatedFetch'],
    ['cloud-server/server.js', 'assembleServerCatalog'],
    ['cloud-server/catalog-assembly.js', 'catalogOperations'],
    ['cloud-server/server-core.js', 'mountCatalog'],
    ['cloud-server/catalog-boot.js', 'createCatalogRouter'],
    ['cloud-server/catalog/routes.js', '/operations`'],
    ['cloud-server/catalog/authority.js', ''],
    ['cloud-server/catalog/operations.js', 'async function putReceipt'],
    ['cloud-server/catalog/library-tx.js', 'queue.enqueue('],
    ['cloud-server/catalog/queue.js', 'INSERT INTO catalog_jobs'],
    ['cloud-server/catalog/direct.js', 'submitReceipt'],
    ['cloud-server/catalog/transport-gateway.js', ''],
    ['cloud-server/catalog-gateway-runtime.js', './catalog-telegram-transport'],
    ['cloud-server/catalog-telegram-transport.js', 'async function catalogDirectSession'],
    ['cloud-server/direct-transport-control.js', 'configureCatalogTelegramTransport({'],
    ['cloud-server/productive-temp-auth-boundary.js', 'transformSession'],
    ['cloud-server/catalog-worker.js', 'assembleWorkerCatalog'],
    ['cloud-server/catalog/worker.js', ''],
    ['cloud-server/catalog/commands.js', ''],
  ],
};
export function measureTraces(repo, files = tracked(repo)) {
  const all = new Set(files);
  return Object.entries(SC).map(([name, hops]) => {
    let files = 0, lineCount = 0, web = 0, cloud = 0;
    const stale = [];
    for (const [file, anchor] of hops) {
      if (!all.has(file)) {
        stale.push(file + ' (file gone)');
        continue;
      }
      const contents = read(repo, file);
      if (anchor && !contents.includes(anchor)) {
        stale.push(file + ' (anchor gone: ' + anchor + ')');
        continue;
      }
      files++;
      lineCount += lines(contents);
      if (file.startsWith('src/')) web++;
      else cloud++;
    }
    return { name, files, lineCount, web, cloud, stale, hops };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = repoArg();
  console.log('HEAD ' + head(repo));
  console.log(['scenario', 'files', 'lines', 'web_files', 'cloud_files', 'stale_hops'].join('\t'));
  for (const { name, files, lineCount, web, cloud, stale, hops } of measureTraces(repo)) {
    console.log([name, files, lineCount, web, cloud, stale.join(' | ') || '-'].join('\t'));
    if (process.argv[3] === 'list') for (const [file] of hops) console.log('    ' + file);
  }
}
