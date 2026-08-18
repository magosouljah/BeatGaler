import { cleanTags, normalizeBeatMetadata, normalizeTag, validateBpm, validateMusicKey, validateTag } from "../../src/lib/metadataValidation.js";
import { deepEqual, equal, runSuite } from "../helpers/testHarness.js";

runSuite("metadata validation", [
  ["normalizes tag whitespace and casing", () => equal(normalizeTag("  Dark   Trap  "), "dark trap", "Tag normalization changed")],
  ["accepts valid tags", () => deepEqual(validateTag("dark-trap_2"), { valid: true, normalized: "dark-trap_2" }, "Valid tag rejected")],
  ["rejects empty tags", () => equal(validateTag("   ").valid, false, "Empty tag must be invalid")],
  ["rejects tags longer than 40 chars", () => equal(validateTag("a".repeat(41)).valid, false, "Long tag must be invalid")],
  ["rejects HTML/XSS-like tag payloads", () => equal(validateTag("<script>alert(1)</script>").valid, false, "Markup must never be a valid tag")],
  ["rejects path-like tags", () => equal(validateTag("../samples").valid, false, "Path-like tag must be invalid")],
  ["deduplicates normalized tags", () => deepEqual(cleanTags(["Trap", " trap ", "DARK"]), { tags: ["trap", "dark"], removed: [] }, "Tag dedupe failed")],
  ["caps clean tags at 30", () => equal(cleanTags(Array.from({ length: 40 }, (_, i) => `tag${i}`)).tags.length, 30, "Tag cap must stay at 30")],
  ["accepts empty BPM", () => deepEqual(validateBpm(""), { valid: true, normalized: "" }, "Empty BPM should remain optional")],
  ["accepts BPM boundaries", () => {
    equal(validateBpm("60").valid, true, "60 BPM should be valid");
    equal(validateBpm("300").valid, true, "300 BPM should be valid");
  }],
  ["rejects BPM outside boundaries", () => {
    equal(validateBpm("59.99").valid, false, "Below 60 BPM should fail");
    equal(validateBpm("300.01").valid, false, "Above 300 BPM should fail");
  }],
  ["normalizes decimal BPM", () => deepEqual(validateBpm(" 120.50 "), { valid: true, normalized: "120.5" }, "Decimal BPM normalization changed")],
  ["rejects malformed BPM", () => {
    for (const value of ["120bpm", "1e2", "NaN", "Infinity", "60.000"]) equal(validateBpm(value).valid, false, `Malformed BPM accepted: ${value}`);
  }],
  ["normalizes major and minor keys", () => {
    deepEqual(validateMusicKey("c# major"), { valid: true, normalized: "C#" }, "Major key normalization changed");
    deepEqual(validateMusicKey("AB MINOR"), { valid: true, normalized: "abm" }, "Minor key normalization changed");
  }],
  ["normalizes unicode accidentals", () => {
    deepEqual(validateMusicKey("F♯"), { valid: true, normalized: "F#" }, "Sharp normalization changed");
    deepEqual(validateMusicKey("e♭m"), { valid: true, normalized: "ebm" }, "Flat normalization changed");
  }],
  ["rejects invalid music keys", () => equal(validateMusicKey("H major").valid, false, "H must not be accepted as a music key")],
  ["normalizes a metadata object without mutating unrelated fields", () => {
    const result = normalizeBeatMetadata({ name: "Beat", tags: [" Trap ", "trap", "LOUD!"], bpm: "120.00", key: "d minor" });
    deepEqual(result, { name: "Beat", tags: ["trap"], bpm: "120", key: "dm" }, "Metadata normalization changed");
  }],
]);
