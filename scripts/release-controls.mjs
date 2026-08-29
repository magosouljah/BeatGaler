import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = path.join(root, "release", "release-controls.json");

function parseVersion(value) {
  const raw = String(value ?? "").trim().replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!match) throw new Error(`invalid semver: ${value}`);
  return { raw, major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] || "" };
}

function compare(aValue, bValue) {
  const a = parseVersion(aValue); const b = parseVersion(bValue);
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

export function loadAndValidatePolicy() {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  if (policy.schemaVersion !== 1) throw new Error("unsupported release-controls schemaVersion");
  if (!policy.channels || typeof policy.channels !== "object") throw new Error("channels are required");
  if (!policy.channels[policy.defaultChannel]) throw new Error("defaultChannel must exist");
  const rings = new Set();
  for (const [name, channel] of Object.entries(policy.channels)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid channel: ${name}`);
    if (!channel?.ring || rings.has(channel.ring)) throw new Error(`ring must be present and unique: ${name}`);
    rings.add(channel.ring);
    parseVersion(channel.minimumVersion);
    if (typeof channel.publicationEnabled !== "boolean") throw new Error(`publicationEnabled must be boolean: ${name}`);
  }
  if (!policy.killSwitch || typeof policy.killSwitch.engaged !== "boolean") throw new Error("killSwitch.engaged must be boolean");
  if (!String(policy.killSwitch.reason || "").trim()) throw new Error("killSwitch.reason is required");
  return policy;
}

export function assertPublicationAllowed(policy, channelName, version) {
  const channel = policy.channels[channelName];
  if (!channel) throw new Error(`unknown release channel: ${channelName}`);
  if (policy.killSwitch.engaged) throw new Error(`release kill switch is engaged: ${policy.killSwitch.reason}`);
  if (!channel.publicationEnabled) throw new Error(`release channel ${channelName} is disabled`);
  if (compare(version, channel.minimumVersion) < 0) throw new Error(`version ${version} is below ${channelName} minimum ${channel.minimumVersion}`);
  return true;
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const policy = loadAndValidatePolicy();
    if (command === "validate") {
      console.log(`PASS release controls: ${Object.keys(policy.channels).join(", ")}; killSwitch=${policy.killSwitch.engaged}`);
    } else if (command === "assert-publish") {
      const channelIndex = args.indexOf("--channel");
      const versionIndex = args.indexOf("--version");
      if (channelIndex < 0 || versionIndex < 0) throw new Error("usage: assert-publish --channel <name> --version <semver>");
      assertPublicationAllowed(policy, args[channelIndex + 1], args[versionIndex + 1]);
      console.log("PASS release publication policy");
    } else {
      throw new Error("usage: release-controls.mjs <validate|assert-publish>");
    }
  } catch (error) {
    console.error(`FAIL release controls: ${error.message}`);
    process.exit(1);
  }
}
