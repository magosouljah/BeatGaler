param(
  [switch]$BuildIfMissing
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
  return
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resourceDir = Join-Path $root "src-tauri\resources\windows"
$runtimeRoot = Join-Path $root "runtime"
$cacheDir = Join-Path $runtimeRoot "windows-bot-api"
$cacheBot = Join-Path $cacheDir "telegram-bot-api.exe"
$resourceBot = Join-Path $resourceDir "telegram-bot-api.exe"
$resourceNode = Join-Path $resourceDir "node.exe"

# Keep these pins aligned with .github/workflows/build-windows.yml. Runtime
# sources and build outputs live only under ignored runtime/resource folders;
# no transport credentials or other secrets are written here.
$botApiCommit = if ($env:BOT_API_COMMIT) { $env:BOT_API_COMMIT } else { "adfd7f6a8e990272851777eeb3ae0def4216f161" }
$vcpkgCommit = if ($env:VCPKG_COMMIT) { $env:VCPKG_COMMIT } else { "7f3781e19cc7d4e4882a4caec01668c6f7b5c163" }

function Assert-WindowsRuntime([string]$Path, [string]$Label, [string[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -lt 1MB) {
    throw "$Label is unexpectedly small: $($item.Length) bytes"
  }
  $stream = [System.IO.File]::OpenRead($item.FullName)
  try {
    $first = $stream.ReadByte()
    $second = $stream.ReadByte()
  } finally {
    $stream.Dispose()
  }
  if ($first -ne 0x4D -or $second -ne 0x5A) {
    throw "$Label is not a Windows PE executable: $Path"
  }
  & $Path @Arguments *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "$Label could not start (exit code $LASTEXITCODE): $Path"
  }
}

function Invoke-Checked([scriptblock]$Command, [string]$Failure) {
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Failure (exit code $LASTEXITCODE)"
  }
}

New-Item -ItemType Directory -Force $resourceDir | Out-Null

$node = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $node -Destination $resourceNode -Force
Assert-WindowsRuntime $resourceNode "BeatGaler Node runtime" @("--version")

# A valid already-staged runtime is enough for local development. This also
# allows an intentional developer build to be reused without rebuilding.
if (Test-Path -LiteralPath $resourceBot -PathType Leaf) {
  try {
    Assert-WindowsRuntime $resourceBot "BeatGaler local data-plane runtime" @("--help")
    Write-Host "BeatGaler Windows runtimes ready."
    return
  } catch {
    Write-Warning "Existing local data-plane runtime is unusable; restaging it. $($_.Exception.Message)"
    Remove-Item -LiteralPath $resourceBot -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path -LiteralPath $cacheBot -PathType Leaf) {
  Assert-WindowsRuntime $cacheBot "Cached BeatGaler local data-plane runtime" @("--help")
  Copy-Item -LiteralPath $cacheBot -Destination $resourceBot -Force
  Assert-WindowsRuntime $resourceBot "BeatGaler local data-plane runtime" @("--help")
  Write-Host "BeatGaler Windows runtimes staged from cache."
  return
}

if (-not $BuildIfMissing) {
  throw "BeatGaler local data-plane runtime is missing. Re-run with -BuildIfMissing to create the pinned static runtime."
}

foreach ($tool in @("git.exe", "cmake.exe")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is required to build the BeatGaler Windows data-plane runtime."
  }
}

$sourceDir = Join-Path $runtimeRoot "telegram-bot-api-source"
$vcpkgDir = Join-Path $runtimeRoot "vcpkg"
$buildDir = Join-Path $runtimeRoot "telegram-bot-api-build"
$installDir = Join-Path $runtimeRoot "telegram-bot-api-install"

New-Item -ItemType Directory -Force $runtimeRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $sourceDir ".git"))) {
  if (Test-Path -LiteralPath $sourceDir) { Remove-Item -LiteralPath $sourceDir -Recurse -Force }
  Invoke-Checked { git clone https://github.com/tdlib/telegram-bot-api.git $sourceDir } "Could not clone the pinned data-plane runtime source"
}
Invoke-Checked { git -C $sourceDir fetch --tags --force origin $botApiCommit } "Could not fetch the pinned data-plane runtime commit"
Invoke-Checked { git -C $sourceDir checkout --force $botApiCommit } "Could not checkout the pinned data-plane runtime commit"
Invoke-Checked { git -C $sourceDir submodule update --init --recursive } "Could not initialize data-plane runtime submodules"

if (-not (Test-Path -LiteralPath (Join-Path $vcpkgDir ".git"))) {
  if (Test-Path -LiteralPath $vcpkgDir) { Remove-Item -LiteralPath $vcpkgDir -Recurse -Force }
  Invoke-Checked { git clone https://github.com/microsoft/vcpkg.git $vcpkgDir } "Could not clone pinned vcpkg"
}
Invoke-Checked { git -C $vcpkgDir fetch --tags --force origin $vcpkgCommit } "Could not fetch pinned vcpkg"
Invoke-Checked { git -C $vcpkgDir checkout --force $vcpkgCommit } "Could not checkout pinned vcpkg"

$vcpkgExe = Join-Path $vcpkgDir "vcpkg.exe"
if (-not (Test-Path -LiteralPath $vcpkgExe -PathType Leaf)) {
  Invoke-Checked { & (Join-Path $vcpkgDir "bootstrap-vcpkg.bat") -disableMetrics } "vcpkg bootstrap failed"
}
Invoke-Checked { & $vcpkgExe install gperf:x64-windows-static openssl:x64-windows-static zlib:x64-windows-static --clean-after-build } "Static runtime dependency installation failed"

$toolchain = Join-Path $vcpkgDir "scripts\buildsystems\vcpkg.cmake"
Invoke-Checked {
  cmake -S $sourceDir -B $buildDir -A x64 `
    -DCMAKE_BUILD_TYPE=Release `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    -DVCPKG_TARGET_TRIPLET=x64-windows-static `
    "-DCMAKE_INSTALL_PREFIX=$installDir"
} "Data-plane runtime configure failed"
Invoke-Checked { cmake --build $buildDir --config Release --target install --parallel 2 } "Data-plane runtime build failed"

$bot = Get-ChildItem $installDir,$buildDir -Filter telegram-bot-api.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $bot) {
  throw "The pinned static build did not produce telegram-bot-api.exe."
}

New-Item -ItemType Directory -Force $cacheDir | Out-Null
Copy-Item -LiteralPath $bot.FullName -Destination $cacheBot -Force
Assert-WindowsRuntime $cacheBot "Built BeatGaler local data-plane runtime" @("--help")
Copy-Item -LiteralPath $cacheBot -Destination $resourceBot -Force
Assert-WindowsRuntime $resourceBot "BeatGaler local data-plane runtime" @("--help")

Write-Host "BeatGaler Windows runtimes built, cached, and staged successfully."
