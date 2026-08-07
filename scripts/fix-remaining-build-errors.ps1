$ErrorActionPreference = 'Stop'
$app = Join-Path $PSScriptRoot '..\src\App.tsx'
if (-not (Test-Path $app)) { throw "No se encontró src\App.tsx" }
$text = Get-Content $app -Raw
$text = $text.Replace(': { beats_folder: folder });', ': { beats_folder: folder, incomplete_warnings_enabled: true });')
$text = $text.Replace(': { beats_folder: folder })}', ': { beats_folder: folder, incomplete_warnings_enabled: true })}')
Set-Content -Path $app -Value $text -Encoding UTF8
Write-Host 'Fixed AppSettings fallbacks in src/App.tsx'
