import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "release", "desktop-manifest.json");

function fail(message) {
  throw new Error(`Release manifest mismatch: ${message}`);
}

function readText(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) fail(`missing ${relative}`);
  return fs.readFileSync(file, "utf8");
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function assertContains(text, needle, label) {
  if (!text.includes(needle)) fail(`${label}: missing ${needle}`);
}

function assertNotContains(text, needle, label) {
  if (text.includes(needle)) fail(`${label}: duplicated literal ${needle}`);
}

function versionChannel(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version).trim());
  if (!match) fail(`VERSION is not semantic version text: ${version}`);
  return match[4] ? match[4].split(".")[0].toLowerCase() : "stable";
}

function validateResources(configPath, expected) {
  const config = readJson(configPath);
  const resources = config?.bundle?.resources ?? {};
  for (const [source, target] of Object.entries(expected)) {
    assertEqual(resources[source], target, `${configPath} resource ${source}`);
  }
}

function load() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) fail("desktop manifest schemaVersion must be 1");
  assertEqual(manifest.versionSource, "VERSION", "version source");
  assertEqual(manifest.channelSource, "VERSION.prerelease", "channel source");
  assertEqual(manifest.productName, "Galer", "product name");
  assertEqual(manifest.bundleIdentifier?.source, "src-tauri/tauri.conf.json", "bundle identifier source");
  assertEqual(manifest.bundleIdentifier?.status, "FINAL", "bundle identifier decision state");
  assertEqual(manifest.bundleIdentifier?.value, "com.beatgaler.app", "bundle identifier value");
  assertEqual(manifest.runtimeSources, "supply-chain/runtime-sources.json", "runtime source manifest");
  assertEqual(manifest.capabilities?.desktop, "src-tauri/capabilities/default.json", "desktop capability source");
  return { manifest, runtimeSources: readJson(manifest.runtimeSources) };
}

export function checkReleaseManifest() {
  const { manifest, runtimeSources } = load();
  const version = readText(manifest.versionSource).trim();
  const channel = versionChannel(version);

  const releaseRepo = String(manifest.updater?.publicReleaseRepo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(releaseRepo)) fail("publicReleaseRepo is invalid");
  const expectedEndpoint = `https://github.com/${releaseRepo}/releases/latest/download/latest.json`;
  assertEqual(manifest.updater?.endpoint, expectedEndpoint, "updater endpoint");
  assertEqual(manifest.updater?.compiledEnv, "BEATGALER_UPDATER_ENDPOINT", "updater compiled env");

  const tauri = readJson("src-tauri/tauri.conf.json");
  assertEqual(tauri.identifier, manifest.bundleIdentifier.value, "Tauri bundle identifier");
  assertEqual(tauri.productName, manifest.productName, "Tauri product name");
  for (const [index, window] of (tauri.app?.windows ?? []).entries()) {
    assertEqual(window.title, manifest.productName, `Tauri window ${index} title`);
  }
  const indexHtml = readText("index.html");
  assertContains(indexHtml, `<title>${manifest.productName}</title>`, "HTML product name");
  assertContains(indexHtml, `Loading ${manifest.productName}...`, "startup loader product name");

  const configuredEndpoints = tauri.plugins?.updater?.endpoints;
  if (Array.isArray(configuredEndpoints) && configuredEndpoints.length > 0) {
    fail("src-tauri/tauri.conf.json must not duplicate the compiled updater endpoint");
  }
  const updaterRust = readText("src-tauri/src/updater.rs");
  assertContains(updaterRust, 'option_env!("BEATGALER_UPDATER_ENDPOINT")', "runtime updater endpoint source");

  const capability = readJson(manifest.capabilities.desktop);
  if (!Array.isArray(capability.windows) || !capability.windows.includes("main")) fail("desktop capability must target main window");
  if (!Array.isArray(capability.permissions) || capability.permissions.length === 0) fail("desktop capability permissions are empty");

  assertEqual(readText(".node-version").trim(), runtimeSources.node?.version, "Node runtime version");
  const rustToolchain = readText("rust-toolchain.toml").match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  assertEqual(rustToolchain, runtimeSources.rustToolchain?.version, "Rust toolchain version");

  const ffmpeg = runtimeSources.ffmpeg ?? {};
  if (!ffmpeg.repository || !ffmpeg.tag) fail("FFmpeg source repository/tag is missing");
  for (const key of ["windows-x64", "darwin-aarch64", "darwin-x86_64"]) {
    if (!ffmpeg.assets?.[key]) fail(`FFmpeg asset mapping is missing ${key}`);
  }
  if (!runtimeSources.telegramBotApi?.commit) fail("Telegram Bot API commit is missing");
  if (!runtimeSources.vcpkg?.commit) fail("vcpkg commit is missing");

  for (const [platform, spec] of Object.entries(manifest.platforms ?? {})) {
    validateResources(spec.tauriConfig, spec.resources);
    if (!Object.keys(spec.resources).some(value => /ffmpeg(?:\.exe)?$/.test(value))) fail(`${platform} omits ffmpeg`);
  }

  const windowsWorkflow = readText(".github/workflows/build-windows.yml");
  const macWorkflow = readText(".github/workflows/build-macos.yml");
  for (const [name, workflow] of [["Windows", windowsWorkflow], ["macOS", macWorkflow]]) {
    assertNotContains(workflow, expectedEndpoint, `${name} workflow updater endpoint`);
    assertContains(workflow, "release-manifest.mjs github-env", `${name} workflow canonical manifest load`);
  }
  assertContains(windowsWorkflow, "BEATGALER_FFMPEG_WINDOWS_ASSET", "Windows FFmpeg source");
  assertContains(windowsWorkflow, "ffmpeg=src-tauri/resources/windows/ffmpeg.exe", "Windows runtime provenance");
  assertContains(macWorkflow, "BEATGALER_FFMPEG_MAC_ARM64_ASSET", "macOS arm64 FFmpeg source");
  assertContains(macWorkflow, "BEATGALER_FFMPEG_MAC_X64_ASSET", "macOS x86_64 FFmpeg source");
  assertContains(macWorkflow, "ffmpeg=src-tauri/resources/ffmpeg", "macOS runtime provenance");

  const releaseWorkflow = readText(".github/workflows/release-desktop-updater.yml");
  assertNotContains(releaseWorkflow, `PUBLIC_RELEASE_REPO: ${releaseRepo}`, "release workflow public repository");
  assertContains(releaseWorkflow, "RELEASE_SOURCE_SHA=$WIN_SHA", "release source SHA capture");
  assertContains(releaseWorkflow, 'git checkout --detach "$RELEASE_SOURCE_SHA"', "release tools source pin");
  assertContains(releaseWorkflow, 'test "$(git rev-parse HEAD)" = "$RELEASE_SOURCE_SHA"', "release tools SHA verification");
  assertContains(releaseWorkflow, "release-manifest.mjs github-env", "release workflow canonical manifest load");
  assertContains(releaseWorkflow, 'WIN_PROVENANCE_SHA="$(jq -r', "Windows provenance SHA validation");
  assertContains(releaseWorkflow, 'MAC_PROVENANCE_SHA="$(jq -r', "macOS provenance SHA validation");
  assertContains(releaseWorkflow, 'test "$WIN_PROVENANCE_SHA" = "$RELEASE_SOURCE_SHA"', "Windows provenance same-SHA gate");
  assertContains(releaseWorkflow, 'test "$MAC_PROVENANCE_SHA" = "$RELEASE_SOURCE_SHA"', "macOS provenance same-SHA gate");
  assertContains(releaseWorkflow, '--target "$RELEASE_SOURCE_SHA"', "immutable release target SHA");
  assertContains(releaseWorkflow, "$BEATGALER_PUBLIC_RELEASE_REPO", "canonical public release repository use");

  console.log(`PASS release manifest: product=${manifest.productName} bundle=${manifest.bundleIdentifier.value} version=${version} channel=${channel} endpoint=${manifest.updater.endpoint}`);
  return { manifest, runtimeSources, version, channel };
}

export function exportGithubEnv() {
  const { manifest, runtimeSources } = checkReleaseManifest();
  const output = process.env.GITHUB_ENV;
  if (!output) fail("GITHUB_ENV is unavailable");
  const values = {
    BEATGALER_UPDATER_ENDPOINT: manifest.updater.endpoint,
    BEATGALER_PUBLIC_RELEASE_REPO: manifest.updater.publicReleaseRepo,
    BEATGALER_NODE_VERSION: runtimeSources.node.version,
    BEATGALER_RUST_VERSION: runtimeSources.rustToolchain.version,
    BEATGALER_BOT_API_COMMIT: runtimeSources.telegramBotApi.commit,
    BEATGALER_VCPKG_COMMIT: runtimeSources.vcpkg.commit,
    BEATGALER_FFMPEG_REPOSITORY: runtimeSources.ffmpeg.repository,
    BEATGALER_FFMPEG_TAG: runtimeSources.ffmpeg.tag,
    BEATGALER_FFMPEG_WINDOWS_ASSET: runtimeSources.ffmpeg.assets["windows-x64"],
    BEATGALER_FFMPEG_MAC_ARM64_ASSET: runtimeSources.ffmpeg.assets["darwin-aarch64"],
    BEATGALER_FFMPEG_MAC_X64_ASSET: runtimeSources.ffmpeg.assets["darwin-x86_64"],
  };
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value).trim()}`);
  fs.appendFileSync(output, `${lines.join("\n")}\n`, "utf8");
  console.log(`Exported ${lines.length} canonical release values to GITHUB_ENV.`);
}

const command = process.argv[2] || "check";
if (command === "check") checkReleaseManifest();
else if (command === "github-env") exportGithubEnv();
else fail(`unknown command ${command}`);
