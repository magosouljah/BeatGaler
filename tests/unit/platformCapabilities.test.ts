import { DESKTOP_CAPABILITIES, WEB_FOUNDATION_CAPABILITIES } from "../../src/platform/capabilities.js";
import { equal, runSuite } from "../helpers/testHarness.js";

runSuite("platform capabilities", [
  ["Desktop retains native features", () => {
    equal(DESKTOP_CAPABILITIES.nativeFilesystemDrop, true, "Desktop native drop must remain enabled");
    equal(DESKTOP_CAPABILITIES.openProjectInDaw, true, "Desktop must keep DAW project opening");
    equal(DESKTOP_CAPABILITIES.installAppUpdates, true, "Desktop must keep native updates");
    equal(DESKTOP_CAPABILITIES.trashLifecycle, true, "Desktop must keep native Trash");
    equal(DESKTOP_CAPABILITIES.playbackCache, true, "Desktop must keep native playback cache");
    equal(DESKTOP_CAPABILITIES.developerTools, true, "Desktop must keep developer tools");
    equal(DESKTOP_CAPABILITIES.localHelper, true, "Desktop must keep its local helper workflows");
    equal(DESKTOP_CAPABILITIES.offlinePackage, true, "Desktop must keep durable Offline packages");
  }],
  ["Web advertises only completed browser import features", () => {
    equal(WEB_FOUNDATION_CAPABILITIES.browserFileImport, true, "Web supports one-file browser picking");
    equal(WEB_FOUNDATION_CAPABILITIES.singleBeatDrop, true, "Web supports one-file library drops");
    equal(WEB_FOUNDATION_CAPABILITIES.browserObjectPlayback, true, "Web previews imported browser audio directly");
    equal(WEB_FOUNDATION_CAPABILITIES.authorizedCloudPlayback, true, "Web streams authorized Cloud MASTER audio");
    equal(WEB_FOUNDATION_CAPABILITIES.reviewBeatCloudCommit, true, "Web commits reviewed browser files to its Cloud library");
    equal(WEB_FOUNDATION_CAPABILITIES.browserCloudDownloads, true, "Web downloads authorized Cloud slots with browser APIs");
    equal(WEB_FOUNDATION_CAPABILITIES.browserCloudEditing, true, "Web edits metadata and replaces Cloud slots transactionally");
    equal(WEB_FOUNDATION_CAPABILITIES.trashLifecycle, true, "Web supports the complete beat Trash lifecycle");
    equal(WEB_FOUNDATION_CAPABILITIES.cloudTrashTransactions, true, "Web moves and restores beats through authoritative Cloud transactions");
    const unfinished = Object.entries(WEB_FOUNDATION_CAPABILITIES)
      .filter(([name]) => !["browserFileImport", "singleBeatDrop", "browserObjectPlayback", "authorizedCloudPlayback", "reviewBeatCloudCommit", "browserCloudDownloads", "browserCloudEditing", "trashLifecycle", "cloudTrashTransactions"].includes(name));
    for (const [name, enabled] of unfinished) {
      equal(enabled, false, `Web capability ${name} must remain disabled until implemented`);
    }
  }],
  ["Web excludes Desktop-only access", () => {
    equal(WEB_FOUNDATION_CAPABILITIES.revealLocalFile, false, "Web cannot reveal local files");
    equal(WEB_FOUNDATION_CAPABILITIES.watchFolders, false, "Web cannot watch Desktop folders");
    equal(WEB_FOUNDATION_CAPABILITIES.openProjectInDaw, false, "Web cannot open a local DAW");
    equal(WEB_FOUNDATION_CAPABILITIES.offlinePackage, false, "Web deliberately has no Offline package mode");
    equal(WEB_FOUNDATION_CAPABILITIES.localHelper, false, "Web cannot expose local helper jobs");
    equal(WEB_FOUNDATION_CAPABILITIES.manualLibraryReorder, false, "Web cannot call the native reorder database path");
  }],
]);
