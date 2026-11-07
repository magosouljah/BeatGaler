#requires -Version 5.1
# BeatGaler T00: solo lecturas Git y pruebas ya inspeccionadas.
# NO AWS / Telegram / PostgreSQL / bases reales / npm install / CI / deploy.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$baseline = '31861e6406ac10073d368aa5d8a4edcb5dfd2d2b'
$expectedBranch = 'local/landing-gallery-unificada'
$results = New-Object 'System.Collections.Generic.List[object]'
$masked = @{}

function Run-NodeCheck {
    param([string]$Label, [string[]]$Arguments)
    Write-Host ""
    Write-Host ("=== T00: " + $Label + " ===") -ForegroundColor Cyan
    & node @Arguments
    $code = $LASTEXITCODE
    $script:results.Add([pscustomobject]@{ Name=$Label; ExitCode=$code }) | Out-Null
    if ($code -ne 0) { Write-Host ("FAIL (" + $code + "): " + $Label) -ForegroundColor Yellow }
}

Push-Location -LiteralPath $repo
try {
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw "No se encontró .git en $repo" }
    $actualRoot = (& git rev-parse --show-toplevel).Trim()
    if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($actualRoot).TrimEnd('\','/') -ine $repo.TrimEnd('\','/')) { throw 'Repositorio Git incorrecto.' }
    $branch = (& git branch --show-current).Trim()
    if ($branch -ne $expectedBranch) { throw "STOP-BASE: rama actual $branch" }
    $head = (& git rev-parse HEAD).Trim()
    & git merge-base --is-ancestor $baseline HEAD
    if ($LASTEXITCODE -ne 0) { throw 'STOP-BASE: falta ancestro 31861e6.' }
    $files = @(& git diff --name-only $baseline HEAD)
    foreach ($file in $files) {
        if (-not $file.StartsWith('docs/plans/catalogo-postgresql/', [StringComparison]::Ordinal)) {
            throw "STOP-BASE: cambio de código ajeno al plan: $file"
        }
    }
    & git diff --quiet
    if ($LASTEXITCODE -ne 0) { throw 'STOP-BASE: hay cambios trackeados sin commit; no ejecutar.' }
    & git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'STOP-BASE: hay cambios preparados; no ejecutar.' }

    Write-Host "Rama: $branch"
    Write-Host "HEAD: $head"
    Write-Host 'Cambios de archivos desde 31861e6: solo documentación del catálogo.'
    Write-Host 'Git status (los no rastreados NO serán modificados):'
    & git status --short

    $migrationNames = @(Get-ChildItem -LiteralPath (Join-Path $repo 'cloud-server\migrations') -Filter '*.sql' -File | Sort-Object Name | ForEach-Object { $_.Name })
    Write-Host ("Migraciones detectadas: " + $migrationNames.Count)
    if ($migrationNames.Count -ne 25 -or -not $migrationNames[0].StartsWith('0001_') -or -not $migrationNames[24].StartsWith('0025_')) {
        throw 'STOP-BASE: inventario de migraciones inesperado.'
    }

    foreach ($folder in @($repo, (Split-Path $repo -Parent), (Split-Path (Split-Path $repo -Parent) -Parent))) {
        if (Test-Path -LiteralPath (Join-Path $folder 'AGENTS.md') -PathType Leaf) {
            throw "STOP-BASE: leer instrucciones AGENTS.md antes de ejecutar: $folder"
        }
    }

    $nodeRaw = (& node --version).Trim()
    $npmRaw = (& npm.cmd --version).Trim()
    Write-Host "Node: $nodeRaw | npm: $npmRaw"
    $nodeVersion = [version]($nodeRaw.TrimStart('v'))
    $npmVersion = [version]$npmRaw
    if ($nodeVersion.Major -ne 22 -or $nodeVersion -lt [version]'22.23.2' -or
        $npmVersion.Major -ne 10 -or $npmVersion -lt [version]'10.9.8') {
        throw 'STOP-ENV: versiones Node/npm fuera del contrato.'
    }

    # Higiene: quitar solo del proceso actual las variables heredadas con posible destino real.
    # Se restauran al final. No se muestra valor ni se pasa a ningún proceso hijo.
    $pattern = '^(DATABASE_URL|RESTORE_DATABASE_URL|CATALOG_TEST_ADMIN_URL|AWS_|AZURE_|BEATGALER_|TELEGRAM_|POLAR_|SMTP_|STRIPE_|GOOGLE_|GITHUB_TOKEN$|GH_TOKEN$|PGHOST$|PGPORT$|PGUSER$|PGPASSWORD$|PGDATABASE$|PGSERVICE$|PGSERVICEFILE$|OPENAI_|SESSION_SECRET$)'
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match $pattern) {
            $masked[$entry.Name] = $entry.Value
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        }
    }

    Run-NodeCheck -Label 'E4: cuotas, esquema y PROJECT (dobles)' -Arguments @(
        '--test', 'cloud-server/tests/library-beat-quota.test.cjs',
        'cloud-server/tests/postgres-schema.test.cjs',
        'cloud-server/tests/project-upload-admission.test.cjs'
    )
    Run-NodeCheck -Label 'PostgreSQL config/runner falsos y Direct assignment' -Arguments @(
        '--test', 'cloud-server/tests/postgres-runtime-config.test.cjs',
        'cloud-server/tests/postgres-migration-runner.test.cjs',
        'cloud-server/tests/direct-persistent-assignment-runtime.test.cjs'
    )

    $vitest = Join-Path $repo 'node_modules\vitest\vitest.mjs'
    if (Test-Path -LiteralPath $vitest -PathType Leaf) {
        Run-NodeCheck -Label 'DOM: Landing, Gallery, tags, UX, loader, selectors' -Arguments @(
            $vitest, 'run',
            'tests/component-dom/webExperience.test.tsx',
            'tests/component-dom/galleryDesign.test.tsx',
            'tests/component-dom/galleryTagPacking.test.ts',
            'tests/component-dom/libraryUxBridge.test.ts',
            'tests/component-dom/publicStartupLoader.test.ts',
            'tests/integration/libraryViewSelectors.test.ts',
            '--environment', 'jsdom'
        )
        Run-NodeCheck -Label 'Issue 97 legacy (diagnóstico; puede fallar por bootstrap antiguo)' -Arguments @(
            $vitest, 'run', 'tests/integration/issue97RuntimeWebFollowup.test.ts',
            '--environment', 'jsdom'
        )
    } else {
        Write-Host 'STOP-ENV: Vitest no está instalado localmente. No instalar dependencias.' -ForegroundColor Yellow
        $results.Add([pscustomobject]@{ Name='Vitest DOM/Issue97'; ExitCode=127 }) | Out-Null
    }

    $tsc = Join-Path $repo 'node_modules\typescript\bin\tsc'
    if (Test-Path -LiteralPath $tsc -PathType Leaf) {
        Run-NodeCheck -Label 'TypeScript --noEmit' -Arguments @($tsc, '--noEmit')
    } else {
        Write-Host 'STOP-ENV: TypeScript local ausente. No instalar dependencias.' -ForegroundColor Yellow
        $results.Add([pscustomobject]@{ Name='TypeScript'; ExitCode=127 }) | Out-Null
    }
} finally {
    foreach ($name in $masked.Keys) {
        [Environment]::SetEnvironmentVariable($name, [string]$masked[$name], 'Process')
    }
    Pop-Location
}

Write-Host ""
Write-Host '=== RESUMEN T00 (copiar aquí la salida sin datos sensibles) ==='
$results | Format-Table -AutoSize
if (@($results | Where-Object { $_.ExitCode -ne 0 }).Count -gt 0) {
    Write-Host 'STOP-TEST: hay fallos/no ejecutados. No iniciar T01.' -ForegroundColor Yellow
    exit 1
}
Write-Host 'Tests whitelist sin fallos. T00 NO ES PASS: falta descriptor DB, C12 y pruebas/validaciones restantes.'
