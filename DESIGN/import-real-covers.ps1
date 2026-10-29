param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = (Resolve-Path -LiteralPath $ZipPath).Path
$destination = Join-Path $PSScriptRoot "shared/assets/real-covers"
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $entries = @($archive.Entries | Where-Object { $_.Name -match '(?i)\.(jpg|jpeg)$' -and $_.Length -gt 0 })
  if ($entries.Count -lt 1) { throw "The ZIP has no JPEG covers." }
  Get-ChildItem -LiteralPath $destination -Filter "cover-*.jpg" -File | Remove-Item -Force
  for ($i = 0; $i -lt $entries.Count; $i++) {
    $target = Join-Path $destination ("cover-{0:D2}.jpg" -f ($i + 1))
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[$i], $target, $true)
  }
  Write-Host ("Imported {0} local JPEG covers into {1}" -f $entries.Count, $destination)
} finally { $archive.Dispose() }
