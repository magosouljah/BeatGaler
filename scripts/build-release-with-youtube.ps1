$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:BEATGALER_GOOGLE_CLIENT_SECRET)) {
  Write-Host ""
  Write-Host "BEATGALER_GOOGLE_CLIENT_SECRET is not set." -ForegroundColor Yellow
  Write-Host "Set it in this PowerShell session, then run this script again."
  Write-Host "The value is injected at compile time and is NOT written to the project."
  exit 1
}

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm run tauri build
exit $LASTEXITCODE
