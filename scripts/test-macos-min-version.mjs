import {
  assertCompatibleMinimumVersions,
  compareVersions,
  parseMacMinimumVersions,
} from "./check-macos-min-version.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`macOS min-version parser regression: ${message}`);
}

const universalFixture = `
Load command 8
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 11.0
      sdk 15.0
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 12.0
      sdk 15.0
`;
const legacyFixture = `
Load command 7
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 11.1
`;

const universal = parseMacMinimumVersions(universalFixture);
assert(universal.length === 2 && universal[0] === "11.0" && universal[1] === "12.0", "Universal LC_BUILD_VERSION slices were not parsed.");
assert(parseMacMinimumVersions(legacyFixture)[0] === "10.15", "legacy LC_VERSION_MIN_MACOSX was not parsed.");
assert(compareVersions("12.0", "12.0") === 0, "equal versions must compare equal.");
assert(compareVersions("11.7", "12.0") < 0, "older minimum must be accepted.");
assert(compareVersions("13.0", "12.0") > 0, "newer minimum must be rejected.");
assertCompatibleMinimumVersions(["10.15", "12.0"], "12.0", "fixture");
let rejected = false;
try {
  assertCompatibleMinimumVersions(["12.0", "13.0"], "12.0", "fixture");
} catch {
  rejected = true;
}
assert(rejected, "a Universal slice newer than the deployment target must fail the gate.");

console.log("PASS macOS Mach-O minimum-version parser and compatibility gate");
