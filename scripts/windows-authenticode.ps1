[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [switch]$RequireExpectedSubject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Rfc3161AuthenticodeOid = "1.3.6.1.4.1.311.3.3.1"
$Sha256Oid = "2.16.840.1.101.3.4.2.1"

function Resolve-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path -LiteralPath $kitsRoot) {
    $candidate = Get-ChildItem -LiteralPath $kitsRoot -Filter signtool.exe -Recurse -File |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw "signtool.exe was not found. Install the Windows SDK signing tools on the runner."
}

function Get-AuthenticodePkcs7 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath
  )

  $bytes = [System.IO.File]::ReadAllBytes($FilePath)
  if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw "$FilePath is not a valid PE executable."
  }

  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or ($peOffset + 24) -ge $bytes.Length) {
    throw "$FilePath has an invalid PE header offset."
  }

  if (
    $bytes[$peOffset] -ne 0x50 -or
    $bytes[$peOffset + 1] -ne 0x45 -or
    $bytes[$peOffset + 2] -ne 0x00 -or
    $bytes[$peOffset + 3] -ne 0x00
  ) {
    throw "$FilePath has an invalid PE signature."
  }

  $optionalHeaderOffset = $peOffset + 24
  $optionalMagic = [System.BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
  switch ($optionalMagic) {
    0x10B { $dataDirectoryOffset = 96 }
    0x20B { $dataDirectoryOffset = 112 }
    default { throw "$FilePath has unsupported PE optional-header magic 0x$('{0:X}' -f $optionalMagic)." }
  }

  # IMAGE_DIRECTORY_ENTRY_SECURITY is index 4. For this entry, VirtualAddress
  # is a file offset rather than an RVA.
  $securityDirectoryOffset = $optionalHeaderOffset + $dataDirectoryOffset + (4 * 8)
  if (($securityDirectoryOffset + 8) -gt $bytes.Length) {
    throw "$FilePath has a truncated PE security directory."
  }

  [long]$certificateOffset = [System.BitConverter]::ToUInt32($bytes, $securityDirectoryOffset)
  [long]$certificateTableSize = [System.BitConverter]::ToUInt32($bytes, $securityDirectoryOffset + 4)
  if ($certificateOffset -eq 0 -or $certificateTableSize -lt 8) {
    throw "$FilePath has no Authenticode certificate table."
  }
  if (($certificateOffset + $certificateTableSize) -gt $bytes.Length) {
    throw "$FilePath has a certificate table outside the file."
  }

  [long]$winCertificateLength = [System.BitConverter]::ToUInt32($bytes, [int]$certificateOffset)
  $certificateType = [System.BitConverter]::ToUInt16($bytes, [int]$certificateOffset + 6)
  if ($winCertificateLength -lt 8 -or $winCertificateLength -gt $certificateTableSize) {
    throw "$FilePath has an invalid WIN_CERTIFICATE length."
  }
  if ($certificateType -ne 0x0002) {
    throw "$FilePath uses unsupported WIN_CERTIFICATE type $certificateType; PKCS#7 is required."
  }

  [long]$pkcs7Length = $winCertificateLength - 8
  $pkcs7 = [byte[]]::new([int]$pkcs7Length)
  [System.Array]::Copy($bytes, $certificateOffset + 8, $pkcs7, 0, $pkcs7Length)
  return $pkcs7
}

function Assert-CryptographicPolicy {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath
  )

  Add-Type -AssemblyName System.Security.Cryptography.Pkcs
  $pkcs7 = Get-AuthenticodePkcs7 -FilePath $FilePath
  $cms = [System.Security.Cryptography.Pkcs.SignedCms]::new()
  $cms.Decode($pkcs7)

  if ($cms.SignerInfos.Count -lt 1) {
    throw "$FilePath has no PKCS#7 signer information."
  }

  $hasRfc3161 = $false
  foreach ($signer in $cms.SignerInfos) {
    if ($signer.DigestAlgorithm.Value -ne $Sha256Oid) {
      throw "$FilePath uses signer digest OID '$($signer.DigestAlgorithm.Value)'; SHA-256 ($Sha256Oid) is required."
    }

    foreach ($attribute in $signer.UnsignedAttributes) {
      if ($attribute.Oid.Value -eq $Rfc3161AuthenticodeOid) {
        $hasRfc3161 = $true
        break
      }
    }
  }

  if (-not $hasRfc3161) {
    throw "$FilePath does not contain the Authenticode RFC3161 timestamp attribute ($Rfc3161AuthenticodeOid)."
  }
}

function Assert-ExpectedPublisher {
  param(
    [Parameter(Mandatory = $true)]
    $Signature,

    [switch]$Required
  )

  $expectedSubject = $env:WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT
  if ([string]::IsNullOrWhiteSpace($expectedSubject)) {
    if ($Required) {
      throw "WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT is required for a public release verification."
    }
    return
  }

  $actualSubject = $Signature.SignerCertificate.Subject
  if ([string]::IsNullOrWhiteSpace($actualSubject) -or -not [string]::Equals($actualSubject.Trim(), $expectedSubject.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Authenticode publisher mismatch. Expected exact subject '$expectedSubject'; actual '$actualSubject'."
  }
}

$resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
$signTool = Resolve-SignTool

& $signTool verify /pa /all /v $resolvedPath
if ($LASTEXITCODE -ne 0) {
  throw "signtool verify /pa /all /v rejected $resolvedPath with exit code $LASTEXITCODE."
}

$signature = Get-AuthenticodeSignature -FilePath $resolvedPath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Get-AuthenticodeSignature rejected $resolvedPath with status '$($signature.Status)': $($signature.StatusMessage)"
}
if (-not $signature.SignerCertificate) {
  throw "$resolvedPath has no Authenticode signer certificate."
}
if (-not $signature.TimeStamperCertificate) {
  throw "$resolvedPath has no trusted Authenticode timestamp certificate."
}

Assert-CryptographicPolicy -FilePath $resolvedPath
Assert-ExpectedPublisher -Signature $signature -Required:$RequireExpectedSubject

Write-Host "PASS Authenticode: $resolvedPath"
Write-Host "  Publisher: $($signature.SignerCertificate.Subject)"
Write-Host "  File digest policy: SHA-256"
Write-Host "  Timestamp: trusted RFC3161"
