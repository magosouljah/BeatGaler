param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$legacyInstallDir = Join-Path $env:RUNNER_TEMP "BeatGaler-074-upgrade-check"
$legacyProductKey = "HKCU:\Software\beatgaler\Beat Galer"
$legacyUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Beat Galer"
$newProductKey = "HKCU:\Software\beatgaler\Galer"
$newUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Galer"
$legacyDesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Beat Galer.lnk"
$newDesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Galer.lnk"
$legacyStartShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Beat Galer.lnk"
$newStartShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Galer.lnk"
$defaultSideBySideDir = Join-Path $env:LOCALAPPDATA "Galer"

function Remove-PathIfPresent([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

try {
  Remove-PathIfPresent $legacyInstallDir
  Remove-PathIfPresent $legacyProductKey
  Remove-PathIfPresent $legacyUninstallKey
  Remove-PathIfPresent $newProductKey
  Remove-PathIfPresent $newUninstallKey
  Remove-PathIfPresent $legacyDesktopShortcut
  Remove-PathIfPresent $newDesktopShortcut
  Remove-PathIfPresent $legacyStartShortcut
  Remove-PathIfPresent $newStartShortcut
  if ($defaultSideBySideDir -ne $legacyInstallDir) {
    Remove-PathIfPresent $defaultSideBySideDir
  }

  New-Item -ItemType Directory -Force $legacyInstallDir | Out-Null
  # 0.7.4's Cargo package is `beat_galer`, so this is the literal historical
  # main-binary name rather than a conveniently different test filename.
  $legacyExe = Join-Path $legacyInstallDir "beat_galer.exe"
  Set-Content -LiteralPath $legacyExe -Value "0.7.4 fixture; not executable" -Encoding ascii
  $legacyExeHash = (Get-FileHash -LiteralPath $legacyExe -Algorithm SHA256).Hash
  Set-Content -LiteralPath (Join-Path $legacyInstallDir "upgrade-sentinel.txt") -Value "legacy-install-location" -Encoding ascii

  New-Item -Path $legacyProductKey -Force | Out-Null
  Set-Item -Path $legacyProductKey -Value $legacyInstallDir
  New-Item -Path $legacyUninstallKey -Force | Out-Null
  New-ItemProperty -Path $legacyUninstallKey -Name "DisplayName" -Value "Beat Galer" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $legacyUninstallKey -Name "DisplayVersion" -Value "0.7.4" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $legacyUninstallKey -Name "InstallLocation" -Value ('"' + $legacyInstallDir + '"') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $legacyUninstallKey -Name "UninstallString" -Value ('"' + (Join-Path $legacyInstallDir "uninstall.exe") + '"') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $legacyUninstallKey -Name "MainBinaryName" -Value "beat_galer.exe" -PropertyType String -Force | Out-Null

  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in @($legacyDesktopShortcut, $legacyStartShortcut)) {
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $legacyExe
    $link.WorkingDirectory = $legacyInstallDir
    $link.Save()
  }

  $process = Start-Process -FilePath $installerPath -ArgumentList @("/S", "/UPDATE") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "0.7.4 -> Galer NSIS upgrade failed with exit code $($process.ExitCode)"
  }

  Assert-True (Test-Path -LiteralPath (Join-Path $legacyInstallDir "upgrade-sentinel.txt") -PathType Leaf) "Upgrade did not reuse the legacy installation directory."
  Assert-True (Test-Path -LiteralPath (Join-Path $legacyInstallDir "uninstall.exe") -PathType Leaf) "Galer uninstaller was not written into the legacy installation directory."

  Assert-True (-not (Test-Path -LiteralPath $legacyProductKey)) "Legacy Beat Galer manufacturer registration was not retired."
  Assert-True (-not (Test-Path -LiteralPath $legacyUninstallKey)) "Legacy Beat Galer uninstall registration was not retired."
  Assert-True (Test-Path -LiteralPath $newProductKey) "Galer manufacturer registration was not created."
  Assert-True (Test-Path -LiteralPath $newUninstallKey) "Galer uninstall registration was not created."

  $registeredInstallLocation = [string](Get-ItemPropertyValue -Path $newUninstallKey -Name "InstallLocation")
  $registeredInstallLocation = $registeredInstallLocation.Trim('"')
  Assert-True ([IO.Path]::GetFullPath($registeredInstallLocation) -eq [IO.Path]::GetFullPath($legacyInstallDir)) "Galer registration points at a side-by-side location instead of the 0.7.4 location."

  $registeredMainBinary = [string](Get-ItemPropertyValue -Path $newUninstallKey -Name "MainBinaryName")
  Assert-True (-not [string]::IsNullOrWhiteSpace($registeredMainBinary)) "Galer registration did not record MainBinaryName."
  $installedMain = Join-Path $legacyInstallDir $registeredMainBinary
  Assert-True (Test-Path -LiteralPath $installedMain -PathType Leaf) "Registered Galer main executable was not written into the legacy installation directory."
  $installedMainHash = (Get-FileHash -LiteralPath $installedMain -Algorithm SHA256).Hash
  Assert-True ($installedMainHash -ne $legacyExeHash) "0.7.4 fixture binary was not replaced by the current Galer executable."

  Assert-True (-not (Test-Path -LiteralPath $legacyDesktopShortcut)) "Legacy desktop shortcut still exists."
  Assert-True (-not (Test-Path -LiteralPath $legacyStartShortcut)) "Legacy Start-menu shortcut still exists."
  Assert-True (Test-Path -LiteralPath $newDesktopShortcut -PathType Leaf) "Existing desktop shortcut choice was not preserved under the Galer name."
  Assert-True (Test-Path -LiteralPath $newStartShortcut -PathType Leaf) "Existing Start-menu shortcut choice was not preserved under the Galer name."

  if ([IO.Path]::GetFullPath($defaultSideBySideDir) -ne [IO.Path]::GetFullPath($legacyInstallDir)) {
    Assert-True (-not (Test-Path -LiteralPath $defaultSideBySideDir)) "Updater created a side-by-side Galer installation under LocalAppData."
  }

  Write-Host "PASS Windows 0.7.4 -> Galer upgrade: current binary, install location, registrations and shortcut choices preserved in-place."
}
finally {
  Remove-PathIfPresent $legacyProductKey
  Remove-PathIfPresent $legacyUninstallKey
  Remove-PathIfPresent $newProductKey
  Remove-PathIfPresent $newUninstallKey
  Remove-PathIfPresent $legacyDesktopShortcut
  Remove-PathIfPresent $newDesktopShortcut
  Remove-PathIfPresent $legacyStartShortcut
  Remove-PathIfPresent $newStartShortcut
  Remove-PathIfPresent $legacyInstallDir
  if ([IO.Path]::GetFullPath($defaultSideBySideDir) -ne [IO.Path]::GetFullPath($legacyInstallDir)) {
    Remove-PathIfPresent $defaultSideBySideDir
  }
}
