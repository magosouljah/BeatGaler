$ErrorActionPreference = "Stop"

# Keep updater signing material outside the BeatGaler repository.
$keyDir = Join-Path $HOME ".beatgaler\updater-signing"
$keyPath = Join-Path $keyDir "beatgaler-updater.key"
$pubPath = "$keyPath.pub"

New-Item -ItemType Directory -Force -Path $keyDir | Out-Null

if (Test-Path $keyPath) {
  Write-Host "Updater private key already exists at: $keyPath"
  Write-Host "Refusing to overwrite it. Losing/changing this key would strand already-installed clients."
  if (Test-Path $pubPath) {
    Write-Host "Public key: $pubPath"
  }
  exit 0
}

Write-Host "Generating BeatGaler updater signing keys OUTSIDE the repository..."
Write-Host "Private key destination: $keyPath"
Write-Host "Choose and preserve the password when Tauri prompts you."

npm run tauri signer generate -- -w $keyPath
if ($LASTEXITCODE -ne 0) { throw "Tauri signer generate failed." }

if (-not (Test-Path $keyPath)) { throw "Private updater key was not created." }
if (-not (Test-Path $pubPath)) { throw "Expected public key file was not created at $pubPath." }

Write-Host ""
Write-Host "SUCCESS: updater signing keypair created."
Write-Host "PRIVATE (never commit/share): $keyPath"
Write-Host "PUBLIC (safe to embed in app config): $pubPath"
Write-Host ""
Write-Host "Public key content:"
Get-Content -Raw $pubPath
