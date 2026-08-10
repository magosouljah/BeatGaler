$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root "cloud-server\server.js"
$rust = Join-Path $root "src-tauri\src\commands.rs"
$newServer = Join-Path $root "patch-files\cloud-server\server.js"
$newRust = Join-Path $root "patch-files\src-tauri\src\commands.rs"

Copy-Item $server "$server.pre-topic-hotfix.bak" -Force
Copy-Item $rust "$rust.pre-topic-hotfix.bak" -Force
Copy-Item $newServer $server -Force
Copy-Item $newRust $rust -Force

node --check $server
if ($LASTEXITCODE -ne 0) {
  Copy-Item "$server.pre-topic-hotfix.bak" $server -Force
  Copy-Item "$rust.pre-topic-hotfix.bak" $rust -Force
  throw "server.js syntax validation failed. Original files restored."
}
Write-Host "[OK] Topics migration + Trash delete hotfix applied."
