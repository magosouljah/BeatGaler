[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$prepareScript = Join-Path $PSScriptRoot "prepare-windows-authenticode-config.ps1"
$baseConfig = Join-Path (Split-Path -Parent $PSScriptRoot) "src-tauri/tauri.windows-release.conf.json"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "beatgaler-authenticode-seam-$([guid]::NewGuid().ToString('N'))"
$outputConfig = Join-Path $tempRoot "tauri.windows-authenticode.conf.json"
New-Item -ItemType Directory -Force $tempRoot | Out-Null

$names = @(
  "WINDOWS_AUTHENTICODE_PROVIDER",
  "WINDOWS_AUTHENTICODE_CERT_SHA1",
  "WINDOWS_RFC3161_TIMESTAMP_URL",
  "WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT"
)
$previous = @{}
foreach ($name in $names) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Set-TestEnvironment {
  param(
    [string]$Provider = "TEST_EXTERNAL_PROVIDER",
    [string]$Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567",
    [string]$TimestampUrl = "https://timestamp.invalid/rfc3161",
    [string]$ExpectedSubject = "CN=Beat Galer Test Publisher, O=Beat Galer Test"
  )

  $env:WINDOWS_AUTHENTICODE_PROVIDER = $Provider
  $env:WINDOWS_AUTHENTICODE_CERT_SHA1 = $Thumbprint
  $env:WINDOWS_RFC3161_TIMESTAMP_URL = $TimestampUrl
  $env:WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT = $ExpectedSubject
}

function Assert-Throws {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedFragment
  )

  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notlike "*$ExpectedFragment*") {
      throw "Expected failure containing '$ExpectedFragment', got: $($_.Exception.Message)"
    }
    return
  }

  throw "Expected action to fail with '$ExpectedFragment', but it succeeded."
}

try {
  Set-TestEnvironment -Provider "PENDING_OWNER_PROVIDER"
  Assert-Throws -ExpectedFragment "PENDING_OWNER_PROVIDER" -Action {
    & $prepareScript -BaseConfigPath $baseConfig -OutputPath $outputConfig
  }

  Set-TestEnvironment -Thumbprint "NOT-A-THUMBPRINT"
  Assert-Throws -ExpectedFragment "40-hex" -Action {
    & $prepareScript -BaseConfigPath $baseConfig -OutputPath $outputConfig
  }

  Set-TestEnvironment -TimestampUrl "http://timestamp.invalid/rfc3161"
  Assert-Throws -ExpectedFragment "absolute HTTPS" -Action {
    & $prepareScript -BaseConfigPath $baseConfig -OutputPath $outputConfig
  }

  Set-TestEnvironment -ExpectedSubject ""
  Assert-Throws -ExpectedFragment "WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT" -Action {
    & $prepareScript -BaseConfigPath $baseConfig -OutputPath $outputConfig
  }

  Set-TestEnvironment
  & $prepareScript -BaseConfigPath $baseConfig -OutputPath $outputConfig

  $config = Get-Content -LiteralPath $outputConfig -Raw | ConvertFrom-Json
  $windows = $config.bundle.windows

  if ($windows.certificateThumbprint -ne "0123456789ABCDEF0123456789ABCDEF01234567") {
    throw "Ephemeral config did not preserve the selected certificate thumbprint."
  }
  if ($windows.digestAlgorithm -ne "sha256") {
    throw "Ephemeral config did not force SHA-256."
  }
  if ($windows.timestampUrl -ne "https://timestamp.invalid/rfc3161") {
    throw "Ephemeral config did not preserve the RFC3161 timestamp URL."
  }
  if ($windows.tsp -ne $true) {
    throw "Ephemeral config did not enable TSP/RFC3161."
  }

  $baseRaw = Get-Content -LiteralPath $baseConfig -Raw
  if ($baseRaw -match '"certificateThumbprint"' -or $baseRaw -match 'PRIVATE KEY' -or $baseRaw -match 'password') {
    throw "Repository base config unexpectedly contains signing identity or secret material."
  }

  $repoRoot = Split-Path -Parent $PSScriptRoot
  $resolvedOutput = (Resolve-Path -LiteralPath $outputConfig).Path
  if ($resolvedOutput.StartsWith((Resolve-Path -LiteralPath $repoRoot).Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Ephemeral Authenticode configuration must be written outside the repository."
  }

  Write-Host "PASS Windows Authenticode seam: public configuration fails closed when deferred/invalid, and valid ephemeral configuration forces SHA-256 + HTTPS RFC3161 without repository credentials."
} finally {
  foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
