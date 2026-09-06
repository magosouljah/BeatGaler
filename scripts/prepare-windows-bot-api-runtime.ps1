$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $root "supply-chain\runtime-sources.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$botCommit = [string]$manifest.telegramBotApi.commit
$vcpkgCommit = [string]$manifest.vcpkg.commit
$triplet = "x64-windows"

if (-not $botCommit -or -not $vcpkgCommit) {
  throw "Pinned Telegram Bot API or vcpkg commit is missing from supply-chain/runtime-sources.json."
}

$runtimeRoot = Join-Path $root "runtime\windows-bot-api-dev"
$sourceDir = Join-Path $runtimeRoot "telegram-bot-api-source"
$buildDir = Join-Path $runtimeRoot "telegram-bot-api-build"
$installDir = Join-Path $runtimeRoot "telegram-bot-api-install"
$vcpkgDir = Join-Path $runtimeRoot "vcpkg"
$resourceDir = Join-Path $root "src-tauri\resources\windows"
$provenancePath = Join-Path $resourceDir "telegram-bot-api.provenance.json"
$runtimeFiles = @(
  "telegram-bot-api.exe",
  "libssl-3-x64.dll",
  "libcrypto-3-x64.dll",
  "z.dll"
)

function Invoke-Checked([string]$label, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) {
    throw "$label failed with exit code $LASTEXITCODE."
  }
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-StagedRuntime {
  if (-not (Test-Path -LiteralPath $provenancePath -PathType Leaf)) { return $false }
  try {
    $provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
  } catch {
    return $false
  }
  if ([string]$provenance.telegram_bot_api_commit -ne $botCommit) { return $false }
  if ([string]$provenance.vcpkg_commit -ne $vcpkgCommit) { return $false }
  if ([string]$provenance.triplet -ne $triplet) { return $false }

  foreach ($name in $runtimeFiles) {
    $path = Join-Path $resourceDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $expected = [string]$provenance.files.$name
    if (-not $expected -or (Get-Sha256 $path) -ne $expected) { return $false }
  }
  return $true
}

if (Test-StagedRuntime) {
  $version = (& (Join-Path $resourceDir "telegram-bot-api.exe") --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Verified Telegram Bot API runtime could not report its version." }
  Write-Host "BeatGaler Telegram Bot API runtime verified: $version ($triplet, $botCommit)"
  return
}

Write-Host "Preparing pinned BeatGaler Telegram Bot API runtime ($triplet)..."
New-Item -ItemType Directory -Force $runtimeRoot,$resourceDir | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $sourceDir ".git") -PathType Container)) {
  if (Test-Path -LiteralPath $sourceDir) { Remove-Item -LiteralPath $sourceDir -Recurse -Force }
  Invoke-Checked "Telegram Bot API clone" { git clone https://github.com/tdlib/telegram-bot-api.git $sourceDir }
}
Invoke-Checked "Telegram Bot API fetch" { git -C $sourceDir fetch --depth 1 origin $botCommit }
Invoke-Checked "Telegram Bot API checkout" { git -C $sourceDir checkout --detach --force $botCommit }
$actualBotCommit = (git -C $sourceDir rev-parse HEAD).Trim()
if ($actualBotCommit -ne $botCommit) { throw "Telegram Bot API source commit mismatch: $actualBotCommit" }
Invoke-Checked "Telegram Bot API submodule sync" { git -C $sourceDir submodule sync --recursive }
Invoke-Checked "Telegram Bot API submodule update" { git -C $sourceDir submodule update --init --recursive --depth 1 }

if (-not (Test-Path -LiteralPath (Join-Path $vcpkgDir ".git") -PathType Container)) {
  if (Test-Path -LiteralPath $vcpkgDir) { Remove-Item -LiteralPath $vcpkgDir -Recurse -Force }
  Invoke-Checked "vcpkg clone" { git clone https://github.com/microsoft/vcpkg.git $vcpkgDir }
}
Invoke-Checked "vcpkg fetch" { git -C $vcpkgDir fetch --depth 1 origin $vcpkgCommit }
Invoke-Checked "vcpkg checkout" { git -C $vcpkgDir checkout --detach --force $vcpkgCommit }
$actualVcpkgCommit = (git -C $vcpkgDir rev-parse HEAD).Trim()
if ($actualVcpkgCommit -ne $vcpkgCommit) { throw "vcpkg source commit mismatch: $actualVcpkgCommit" }

$vcpkgExe = Join-Path $vcpkgDir "vcpkg.exe"
if (-not (Test-Path -LiteralPath $vcpkgExe -PathType Leaf)) {
  Invoke-Checked "vcpkg bootstrap" { & (Join-Path $vcpkgDir "bootstrap-vcpkg.bat") -disableMetrics }
}
Invoke-Checked "vcpkg dependency installation" {
  & $vcpkgExe install "gperf:$triplet" "openssl:$triplet" "zlib:$triplet" --clean-after-build
}

if (Test-Path -LiteralPath $buildDir) { Remove-Item -LiteralPath $buildDir -Recurse -Force }
if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }

$toolchain = Join-Path $vcpkgDir "scripts\buildsystems\vcpkg.cmake"
Invoke-Checked "Telegram Bot API configure" {
  cmake -S $sourceDir -B $buildDir -A x64 `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    "-DVCPKG_TARGET_TRIPLET=$triplet" `
    "-DCMAKE_INSTALL_PREFIX=$installDir"
}
Invoke-Checked "Telegram Bot API build" {
  cmake --build $buildDir --config Release --target install --parallel 2
}

foreach ($name in $runtimeFiles) {
  $artifact = Get-ChildItem -Path $installDir,$buildDir -Filter $name -File -Recurse | Select-Object -First 1
  if (-not $artifact) { throw "Telegram Bot API build did not produce required runtime file: $name" }
  Copy-Item -LiteralPath $artifact.FullName -Destination (Join-Path $resourceDir $name) -Force
}

Invoke-Checked "Telegram Bot API runtime version check" {
  & (Join-Path $resourceDir "telegram-bot-api.exe") --version
}

$hashes = [ordered]@{}
foreach ($name in $runtimeFiles) {
  $hashes[$name] = Get-Sha256 (Join-Path $resourceDir $name)
}
$provenance = [ordered]@{
  schema_version = 1
  telegram_bot_api_commit = $botCommit
  vcpkg_commit = $vcpkgCommit
  triplet = $triplet
  files = $hashes
}
$provenance | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $provenancePath -Encoding utf8

Write-Host "BeatGaler Telegram Bot API runtime prepared from pinned source ($triplet, $botCommit)."
