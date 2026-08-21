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
  }],
  ["Web foundation never advertises unfinished features", () => {
    for (const [name, enabled] of Object.entries(WEB_FOUNDATION_CAPABILITIES)) {
      equal(enabled, false, `Web capability ${name} must remain disabled until implemented`);
    }
  }],
  ["Web excludes Desktop-only access", () => {
    equal(WEB_FOUNDATION_CAPABILITIES.revealLocalFile, false, "Web cannot reveal local files");
    equal(WEB_FOUNDATION_CAPABILITIES.watchFolders, false, "Web cannot watch Desktop folders");
    equal(WEB_FOUNDATION_CAPABILITIES.openProjectInDaw, false, "Web cannot open a local DAW");
  }],
]);
