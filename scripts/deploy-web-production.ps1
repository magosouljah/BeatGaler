param(
  [Parameter(Mandatory = $true)]
  [string]$KeyPath,
  [string]$HostName = "api.beatgaler.com",
  [string]$RemoteUser = "ec2-user",
  [switch]$SkipNpmCi
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ArchivePath = Join-Path ([System.IO.Path]::GetTempPath()) ("beatgaler-web-" + [guid]::NewGuid().ToString("N") + ".tgz")

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath $KeyPath)) {
  throw "EC2 SSH key not found: $KeyPath"
}

Push-Location $RepoRoot
try {
  if (-not $SkipNpmCi) {
    Invoke-NativeChecked -Command "npm" -Arguments @("ci")
  }

  Invoke-NativeChecked -Command "npm" -Arguments @("run", "build:web")

  $DistPath = Join-Path $RepoRoot "dist"
  $IndexPath = Join-Path $DistPath "index.html"
  if (-not (Test-Path -LiteralPath $IndexPath)) {
    throw "Web build completed without dist/index.html"
  }

  Invoke-NativeChecked -Command "tar" -Arguments @("-czf", $ArchivePath, "-C", $DistPath, ".")

  $SshTarget = "${RemoteUser}@${HostName}"
  $CommonSsh = @("-o", "StrictHostKeyChecking=accept-new", "-i", $KeyPath)

  Invoke-NativeChecked -Command "scp" -Arguments ($CommonSsh + @(
    $ArchivePath,
    "${SshTarget}:/tmp/beatgaler-web.tgz"
  ))

  Invoke-NativeChecked -Command "scp" -Arguments ($CommonSsh + @(
    (Join-Path $RepoRoot "deploy\web\install-web-production.sh"),
    (Join-Path $RepoRoot "deploy\web\beatgaler.com.bootstrap.conf"),
    (Join-Path $RepoRoot "deploy\web\beatgaler.com.conf"),
    "${SshTarget}:/tmp/"
  ))

  Invoke-NativeChecked -Command "ssh" -Arguments ($CommonSsh + @(
    $SshTarget,
    "sudo bash /tmp/install-web-production.sh /tmp/beatgaler-web.tgz /tmp/beatgaler.com.bootstrap.conf /tmp/beatgaler.com.conf"
  ))

  Write-Host "BeatGaler Web deployed: https://beatgaler.com"
}
finally {
  Pop-Location
  Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
}
