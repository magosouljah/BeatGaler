$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
Set-Location $root
$base = Join-Path $root 'tmp/playback-d'
New-Item -ItemType Directory -Force -Path $base | Out-Null

$cases = @(
  @{ Name = 'd4-101-first-0'; Order = '101'; Offset = 0; Runs = 12 },
  @{ Name = 'd4-96-first-10'; Order = '96'; Offset = 10; Runs = 12 },
  @{ Name = 'd4-101-first-10'; Order = '101'; Offset = 10; Runs = 12 },
  @{ Name = 'd4-96-first-50'; Order = '96'; Offset = 50; Runs = 12 },
  @{ Name = 'd4-101-first-50'; Order = '101'; Offset = 50; Runs = 12 },
  @{ Name = 'd4-96-first-100'; Order = '96'; Offset = 100; Runs = 12 },
  @{ Name = 'd4-101-first-100'; Order = '101'; Offset = 100; Runs = 12 }
)
foreach ($case in $cases) {
  $out = Join-Path $base $case.Name
  $log = Join-Path $base ($case.Name + '-console.txt')
  Write-Host ('Starting ' + $case.Name)
  & node scripts/run-playback-direct.mjs --runs $case.Runs --mode test-d-raw --test-d-mode observe --test-d-order $case.Order --test-d-offset-ms $case.Offset --out $out *> $log
  if ($LASTEXITCODE -ne 0) { throw ('Test D4 failed: ' + $case.Name) }
}

$name = 'd4-sequential-96-then-101'
$out = Join-Path $base $name
$log = Join-Path $base ($name + '-console.txt')
Write-Host ('Starting ' + $name)
& node scripts/run-playback-direct.mjs --runs 20 --mode test-d-raw --test-d-mode observe --test-d-sequential true --out $out *> $log
if ($LASTEXITCODE -ne 0) { throw ('Test D4 failed: ' + $name) }
