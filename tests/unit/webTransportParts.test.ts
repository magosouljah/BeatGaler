import {
  WEB_DIRECT_MAX_FILE_BYTES,
  WEB_DIRECT_PART_BYTES,
  planWebUploadParts,
} from "../../src/features/cloud/webTransportParts.js";
import { equal, runSuite } from "../helpers/testHarness.js";

runSuite("Galer Cloud Web upload parts", [
  ["keeps every part below the direct Web download ceiling", () => {
    const parts = planWebUploadParts(WEB_DIRECT_MAX_FILE_BYTES, "PROJECT.zip");
    equal(parts.length, 100, "1.9 GB must split into 100 deterministic parts");
    equal(parts.every(part => part.size <= WEB_DIRECT_PART_BYTES), true, "No part may exceed 19 MiB");
    equal(parts.reduce((total, part) => total + part.size, 0), WEB_DIRECT_MAX_FILE_BYTES, "Parts must cover every byte once");
  }],
  ["preserves a small file as one original filename", () => {
    const parts = planWebUploadParts(1024, "beat.wav");
    equal(parts.length, 1, "Small files should not be fragmented");
    equal(parts[0].filename, "beat.wav", "Single-part filenames stay unchanged");
    equal(parts[0].offset, 0, "The first part starts at byte zero");
  }],
  ["rejects files beyond the Web plan limit", () => {
    let message = "";
    try { planWebUploadParts(WEB_DIRECT_MAX_FILE_BYTES + 1, "too-large.zip"); }
    catch (error) { message = String((error as Error).message); }
    equal(message.includes("1.9 GB"), true, "The limit error must be explicit");
  }],
]);
