$ErrorActionPreference = "Stop"

$repo = "E:\777\app\beatvault"
$cloudDir = Join-Path $repo "cloud-server"
$botDir = if ($env:BEATGALER_BOT_API_SOURCE_DIR) { $env:BEATGALER_BOT_API_SOURCE_DIR } else { "D:\BeatGalerBotAPI\telegram-bot-api\build\Release" }
$botExe = Join-Path $botDir "telegram-bot-api.exe"
$resourceDir = Join-Path $repo "src-tauri\resources\windows"

Write-Host ""
Write-Host "BeatGaler local cloud launcher"
Write-Host "----------------------------"

if (-not (Test-Path $repo)) {
    throw "BeatGaler repo not found: $repo"
}
if (-not (Test-Path $cloudDir)) {
    throw "Cloud server folder not found: $cloudDir"
}
if (-not (Test-Path $botExe)) {
    throw "BeatGaler local data-plane runtime not found: $botExe"
}

# Development provisioning only. src-tauri/resources/windows is gitignored, so
# runtime executables/DLLs remain local and can never expose backend credentials.
# Release CI builds its own statically linked runtime and stages it separately.
Write-Host "Staging BeatGaler Windows development runtime..."
New-Item -ItemType Directory -Force $resourceDir | Out-Null

$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $resourceDir "node.exe") -Force
Copy-Item -LiteralPath $botExe -Destination (Join-Path $resourceDir "telegram-bot-api.exe") -Force

foreach ($dllName in @("libcrypto-3-x64.dll", "libssl-3-x64.dll", "z.dll")) {
    $dllSource = Join-Path $botDir $dllName
    $dllTarget = Join-Path $resourceDir $dllName
    if (Test-Path -LiteralPath $dllSource -PathType Leaf) {
        Copy-Item -LiteralPath $dllSource -Destination $dllTarget -Force
    } elseif (Test-Path -LiteralPath $dllTarget -PathType Leaf) {
        Remove-Item -LiteralPath $dllTarget -Force
    }
}

$stagedNode = Join-Path $resourceDir "node.exe"
$stagedBot = Join-Path $resourceDir "telegram-bot-api.exe"
& $stagedNode --version
if ($LASTEXITCODE -ne 0) {
    throw "Staged BeatGaler Node runtime is not executable (exit $LASTEXITCODE)."
}

Push-Location $resourceDir
try {
    & $stagedBot --help | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Staged BeatGaler local data-plane runtime cannot start (exit $LASTEXITCODE). Check its adjacent runtime DLLs."
    }
} finally {
    Pop-Location
}
Write-Host "BeatGaler development runtime ready in $resourceDir"

if (-not $env:TELEGRAM_API_ID) {
    $env:TELEGRAM_API_ID = Read-Host "Telegram API ID"
}
if (-not $env:TELEGRAM_API_HASH) {
    $env:TELEGRAM_API_HASH = Read-Host "Telegram API Hash"
}

if ([string]::IsNullOrWhiteSpace($env:TELEGRAM_API_ID) -or
    [string]::IsNullOrWhiteSpace($env:TELEGRAM_API_HASH)) {
    throw "TELEGRAM_API_ID and TELEGRAM_API_HASH are required."
}

Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match [regex]::Escape($cloudDir) -and
        $_.CommandLine -match "server\.js"
    } |
    ForEach-Object {
        Write-Host "Stopping old BeatGaler Cloud server PID $($_.ProcessId)..."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

$botPortOpen = $false
try {
    $botPortOpen = Test-NetConnection 127.0.0.1 -Port 8081 -InformationLevel Quiet -WarningAction SilentlyContinue
} catch {}

if (-not $botPortOpen) {
    Write-Host "Starting Telegram Bot API on 127.0.0.1:8081..."
    $botCmd = @"
Set-Location '$botDir'
& '$botExe' --api-id=$env:TELEGRAM_API_ID --api-hash=$env:TELEGRAM_API_HASH --local --http-port=8081 --verbosity=3
"@
    Start-Process powershell.exe -ArgumentList @(
        "-NoExit",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", $botCmd
    )

    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        try {
            $botPortOpen = Test-NetConnection 127.0.0.1 -Port 8081 -InformationLevel Quiet -WarningAction SilentlyContinue
        } catch {
            $botPortOpen = $false
        }
    } until ($botPortOpen -or (Get-Date) -ge $deadline)

    if (-not $botPortOpen) {
        throw "Telegram Bot API did not open port 8081. Check the Telegram Bot API window."
    }
} else {
    Write-Host "Telegram Bot API already running on port 8081."
}

Write-Host "Starting BeatGaler Cloud server on 127.0.0.1:4000..."
$cloudCmd = @"
Set-Location '$cloudDir'
`$env:BEATGALER_DEV_PLAN_SWITCH='1'
node server.js
"@
Start-Process powershell.exe -ArgumentList @(
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", $cloudCmd
)

$cloudPortOpen = $false
$deadline = (Get-Date).AddSeconds(15)
do {
    Start-Sleep -Milliseconds 500
    try {
        $cloudPortOpen = Test-NetConnection 127.0.0.1 -Port 4000 -InformationLevel Quiet -WarningAction SilentlyContinue
    } catch {
        $cloudPortOpen = $false
    }
} until ($cloudPortOpen -or (Get-Date) -ge $deadline)

if (-not $cloudPortOpen) {
    throw "BeatGaler Cloud server did not open port 4000. Check the Cloud Server window."
}

Write-Host "Starting BeatGaler Tauri dev..."
$appCmd = @"
`$env:BEATGALER_CLOUD_API='http://127.0.0.1:4000'
Set-Location '$repo'
npm run tauri dev
"@
Start-Process powershell.exe -ArgumentList @(
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", $appCmd
)

Write-Host ""
Write-Host "Started:"
Write-Host "  Telegram Bot API : http://127.0.0.1:8081"
Write-Host "  BeatGaler Cloud  : http://127.0.0.1:4000"
Write-Host "  BeatGaler app    : npm run tauri dev"
Write-Host ""
Write-Host "Keep the three PowerShell windows open while testing."
