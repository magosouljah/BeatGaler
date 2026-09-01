[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BaseConfigPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$provider = $env:WINDOWS_AUTHENTICODE_PROVIDER
if ([string]::IsNullOrWhiteSpace($provider) -or $provider -eq "PENDING_OWNER_PROVIDER") {
  throw "Public Windows signing is fail-closed: WINDOWS_AUTHENTICODE_PROVIDER is PENDING_OWNER_PROVIDER."
}

$thumbprint = ($env:WINDOWS_AUTHENTICODE_CERT_SHA1 -replace '\s', '')
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
  throw "WINDOWS_AUTHENTICODE_CERT_SHA1 is required. Certificate/private-key material must remain outside the repository."
}
if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
  throw "WINDOWS_AUTHENTICODE_CERT_SHA1 must be a 40-hex certificate thumbprint."
}

$timestampUrl = $env:WINDOWS_RFC3161_TIMESTAMP_URL
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
  throw "WINDOWS_RFC3161_TIMESTAMP_URL is required for public signing."
}
$timestampUri = [System.Uri]$timestampUrl
if (-not $timestampUri.IsAbsoluteUri -or $timestampUri.Scheme -ne "https") {
  throw "WINDOWS_RFC3161_TIMESTAMP_URL must be an absolute HTTPS RFC3161 endpoint."
}

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT)) {
  throw "WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT is required for public signing."
}

$base = Get-Content -LiteralPath $BaseConfigPath -Raw | ConvertFrom-Json -AsHashtable
if (-not $base.ContainsKey("bundle")) {
  $base["bundle"] = @{}
}
if (-not $base["bundle"].ContainsKey("windows")) {
  $base["bundle"]["windows"] = @{}
}

# Tauri performs Windows code signing inside the bundling pipeline. This is
# deliberate: the application executable and installer are signed before
# Tauri emits the updater .sig for the final installer bytes.
$base["bundle"]["windows"]["certificateThumbprint"] = $thumbprint
$base["bundle"]["windows"]["digestAlgorithm"] = "sha256"
$base["bundle"]["windows"]["timestampUrl"] = $timestampUrl
$base["bundle"]["windows"]["tsp"] = $true

$parent = Split-Path -Parent $OutputPath
if ($parent) {
  New-Item -ItemType Directory -Force $parent | Out-Null
}
$base | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $OutputPath -Encoding utf8

Write-Host "Prepared ephemeral Tauri Authenticode config for provider '$provider'."
Write-Host "Certificate/private-key material was not written to the repository."
