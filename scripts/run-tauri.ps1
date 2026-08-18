# Intentionally use PowerShell's automatic $args collection instead of a
# advanced remaining-arguments parameter declaration. The latter turns
# this script into an advanced script and makes CLI flags such as `-w`
# collide with PowerShell common parameters like -WarningAction.
$TauriArgs = @($args)

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
  throw "Visual Studio Build Tools were not found. Install the C++ Build Tools first."
}

$installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installPath) {
  throw "Visual Studio C++ Build Tools were not found. Install the Desktop C++ workload first."
}

$devShellModule = Join-Path $installPath "Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Import-Module $devShellModule
Enter-VsDevShell -VsInstallPath $installPath -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64 -no_logo" | Out-Null

$tauriCli = Join-Path $PSScriptRoot "..\node_modules\.bin\tauri.cmd"
if (-not (Test-Path $tauriCli)) {
  throw "Tauri CLI was not found. Run npm install first."
}

# BeatGaler Option 2: patch only WRY's existing WebView2 IDropTarget. This is
# idempotent and preserves CF_HDROP as the zero-copy local filesystem fast path.
$wryPatchScript = Join-Path $PSScriptRoot "patch-wry-pinterest.mjs"
& node $wryPatchScript
if ($LASTEXITCODE -ne 0) {
  throw "BeatGaler WRY Pinterest patch failed with exit code $LASTEXITCODE."
}

& $tauriCli @TauriArgs
exit $LASTEXITCODE
