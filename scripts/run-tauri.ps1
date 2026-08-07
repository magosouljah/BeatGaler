param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArgs
)

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

& $tauriCli @TauriArgs
exit $LASTEXITCODE
