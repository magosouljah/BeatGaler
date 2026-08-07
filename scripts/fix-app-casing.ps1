$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "..\src"
$lower = Join-Path $src "app.tsx"
$upper = Join-Path $src "App.tsx"
$tmp = Join-Path $src "__App_case_fix__.tsx"

# Windows can preserve the old casing, so force a two-step rename.
if (Test-Path $lower) {
  Move-Item -LiteralPath $lower -Destination $tmp -Force
  Move-Item -LiteralPath $tmp -Destination $upper -Force
  Write-Host "Normalized src/app.tsx -> src/App.tsx"
} else {
  Write-Host "src/app.tsx not found; no casing change needed."
}
