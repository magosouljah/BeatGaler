import { deepEqual, equal, runAsyncSuite, runSuite } from "../helpers/testHarness.js";
import { preferredExternalDropEffect } from "../../src/features/dragdrop/externalDropEffect.js";
import {
  NATIVE_EXTERNAL_IMAGE_PENDING,
  NATIVE_EXTERNAL_IMAGE_PREFIX,
  nativeExternalImageSignalFromPaths,
} from "../../src/features/dragdrop/nativeExternalImage.js";
import {
  claimNativeLibraryDrop,
  waitForNativeLibraryDropClaim,
} from "../../src/features/dragdrop/nativeDropArbiter.js";

runSuite("Drag/drop external image decoding", [
  ["recognizes pending native image signal", () => {
    deepEqual(nativeExternalImageSignalFromPaths([NATIVE_EXTERNAL_IMAGE_PENDING]), { kind: "pending" }, "pending sentinel should decode");
  }],
  ["rejects more than one path", () => {
    equal(nativeExternalImageSignalFromPaths(["a", "b"]), null, "multiple values must never be treated as the image sentinel");
  }],
  ["rejects normal filesystem paths", () => {
    equal(nativeExternalImageSignalFromPaths(["C:\\Beats\\beat.mp3"]), null, "normal local files must stay on the filesystem path");
  }],
  ["decodes a Pinterest image URL", () => {
    const url = "https://i.pinimg.com/736x/aa/bb/cc/image.jpg";
    const encoded = `${NATIVE_EXTERNAL_IMAGE_PREFIX}${encodeURIComponent(url)}`;
    deepEqual(nativeExternalImageSignalFromPaths([encoded]), { kind: "drop", url, source: "pinterest" }, "pinimg URLs should be classified as Pinterest");
  }],
  ["decodes a generic browser image URL", () => {
    const url = "https://images.example.com/artwork.png";
    const encoded = `${NATIVE_EXTERNAL_IMAGE_PREFIX}${encodeURIComponent(url)}`;
    deepEqual(nativeExternalImageSignalFromPaths([encoded]), { kind: "drop", url, source: "browser" }, "generic HTTP images should remain browser sources");
  }],
  ["rejects non-http protocols", () => {
    const encoded = `${NATIVE_EXTERNAL_IMAGE_PREFIX}${encodeURIComponent("file:///C:/secret.txt")}`;
    equal(nativeExternalImageSignalFromPaths([encoded]), null, "file:// must not enter browser-image import");
  }],
  ["rejects malformed URL encoding", () => {
    equal(nativeExternalImageSignalFromPaths([`${NATIVE_EXTERNAL_IMAGE_PREFIX}%E0%A4%A`]), null, "malformed percent encoding must be ignored safely");
  }],
  ["rejects an empty external-image payload", () => {
    equal(nativeExternalImageSignalFromPaths([NATIVE_EXTERNAL_IMAGE_PREFIX]), null, "empty sentinel payload must be ignored");
  }],
]);

runSuite("Drag/drop effect negotiation", [
  ["link-only source uses link", () => equal(preferredExternalDropEffect("link"), "link", "link-only source")],
  ["linkMove uses link", () => equal(preferredExternalDropEffect("linkMove"), "link", "linkMove source")],
  ["move-only source uses move", () => equal(preferredExternalDropEffect("move"), "move", "move-only source")],
  ["none stays none", () => equal(preferredExternalDropEffect("none"), "none", "none source")],
  ["copy uses copy", () => equal(preferredExternalDropEffect("copy"), "copy", "copy source")],
  ["copyLink uses copy", () => equal(preferredExternalDropEffect("copyLink"), "copy", "copyLink source")],
  ["copyMove uses copy", () => equal(preferredExternalDropEffect("copyMove"), "copy", "copyMove source")],
  ["all uses copy", () => equal(preferredExternalDropEffect("all"), "copy", "all source")],
  ["uninitialized defaults to copy", () => equal(preferredExternalDropEffect("uninitialized"), "copy", "uninitialized source")],
]);

await runAsyncSuite("Native filesystem drop arbitration", [
  ["a native claim at the same moment wins immediately", async () => {
    claimNativeLibraryDrop(1000);
    equal(await waitForNativeLibraryDropClaim(1000, 0), true, "same Windows drop should be owned by native fast path");
  }],
  ["a recent native claim inside tolerance wins", async () => {
    claimNativeLibraryDrop(1880);
    equal(await waitForNativeLibraryDropClaim(2000, 0), true, "120 ms tolerance should connect duplicate WebView/native events");
  }],
  ["an older unrelated native claim does not steal a new HTML drop", async () => {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    claimNativeLibraryDrop(1000);
    equal(await waitForNativeLibraryDropClaim(1201, 0), false, "old native event must not suppress a later browser drop");
  }],
]);
