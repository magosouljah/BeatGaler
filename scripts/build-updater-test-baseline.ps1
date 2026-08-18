# Ruta fija de la private key del updater
$PrivateKeyPath = "C:\Users\GTA7\.beatgaler\updater-signing\beatgaler-updater.key"

# Version que queremos usar como baseline real para probar 0.6.1 -> 0.6.2
$BaselineVersion = "0.6.1"

# Guarda la version actual para restaurarla al terminar
$OriginalVersion = (Get-Content (Join-Path $PSScriptRoot "..\VERSION") -Raw).Trim()

# Verifica que la private key exista antes de continuar
if (-not (Test-Path $PrivateKeyPath)) {
  throw "Updater private key not found: $PrivateKeyPath"
}

# Obtiene el remote real del repositorio para no hardcodear otro repo por accidente
$GitOrigin = (git remote get-url origin).Trim()

if (-not $GitOrigin) {
  throw "Could not resolve git remote origin."
}

# Convierte un remote HTTPS de GitHub en owner/repo
if ($GitOrigin -match '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$') {
  $GitHubRepository = "$($Matches[1])/$($Matches[2])"
}
# Convierte tambien un remote SSH de GitHub en owner/repo
elseif ($GitOrigin -match '^git@github\.com:([^/]+)/(.+?)(?:\.git)?$') {
  $GitHubRepository = "$($Matches[1])/$($Matches[2])"
}
else {
  throw "Unsupported GitHub origin: $GitOrigin"
}

# Construye el endpoint real de latest.json a partir del repo actual
$UpdaterEndpoint = "https://github.com/$GitHubRepository/releases/latest/download/latest.json"

Write-Host ""
Write-Host "Baseline version: $BaselineVersion"
Write-Host "Original version: $OriginalVersion"
Write-Host "GitHub repository: $GitHubRepository"
Write-Host "Updater endpoint: $UpdaterEndpoint"
Write-Host ""

# Limpia variables antiguas antes de empezar
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:\BEATGALER_UPDATER_ENDPOINT -ErrorAction SilentlyContinue

$passwordIsValid = $false
$probeFile = Join-Path $env:TEMP "beatgaler-updater-key-probe.txt"

try {
  # Compila el endpoint HTTPS dentro del baseline 0.6.1
  $env:BEATGALER_UPDATER_ENDPOINT = $UpdaterEndpoint

  # Baja temporalmente TODO el proyecto a 0.6.1 usando la fuente central VERSION
  if ($OriginalVersion -ne $BaselineVersion) {
    Write-Host "Temporarily switching project version to $BaselineVersion..."

    npm run version:set -- $BaselineVersion

    if ($LASTEXITCODE -ne 0) {
      throw "Could not switch project to baseline version $BaselineVersion."
    }
  }

  # Comprueba que todos los archivos quedaron realmente en 0.6.1
  npm run version:check

  if ($LASTEXITCODE -ne 0) {
    throw "Baseline version synchronization check failed."
  }

  do {
    # Pide la contraseña sin mostrarla
    $securePassword = Read-Host "Updater signing-key password" -AsSecureString

    # Convierte temporalmente SecureString para entregarlo a Tauri
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

    try {
      $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)

      # Entrega la contraseña solo a los procesos hijos de esta sesion
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $plainPassword

      # Crea un archivo diminuto para comprobar la contraseña antes del build largo
      Set-Content `
        -Path $probeFile `
        -Value "BeatGaler updater signing-key verification" `
        -NoNewline

      # Elimina cualquier firma residual del probe
      Remove-Item "$probeFile.sig" -Force -ErrorAction SilentlyContinue

      # Verifica la contraseña usando la private key como archivo
      npm run tauri -- signer sign $probeFile -f $PrivateKeyPath

      $passwordIsValid = ($LASTEXITCODE -eq 0)

      if (-not $passwordIsValid) {
        Write-Host ""
        Write-Host "Wrong password. Try again."
        Write-Host ""
      }
    }
    finally {
      # Borra de memoria la copia temporal de la contraseña
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
      $plainPassword = $null
    }

    # Limpia los archivos temporales del probe
    Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    Remove-Item "$probeFile.sig" -Force -ErrorAction SilentlyContinue
  }
  until ($passwordIsValid)

  Write-Host ""
  Write-Host "Password verified. Building signed updater-capable Beat Galer $BaselineVersion baseline..."
  Write-Host ""

  # Evita conflicto entre private-key-path y private-key
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue

  # El bundler usa esta variable para firmar los updater artifacts
  $env:TAURI_SIGNING_PRIVATE_KEY = $PrivateKeyPath

  # Construye solamente NSIS para este baseline de prueba
  npm run tauri -- build --bundles nsis

  if ($LASTEXITCODE -ne 0) {
    throw "Baseline build failed."
  }

  # Define las rutas exactas esperadas del baseline 0.6.1
  $InstallerPath = Join-Path `
    $PSScriptRoot `
    "..\src-tauri\target\release\bundle\nsis\Beat Galer_${BaselineVersion}_x64-setup.exe"

  $SignaturePath = "$InstallerPath.sig"

  # Verifica que el instalador exista
  if (-not (Test-Path $InstallerPath)) {
    throw "Baseline installer was not created: $InstallerPath"
  }

  # Verifica que la firma exista
  if (-not (Test-Path $SignaturePath)) {
    throw "Updater signature was not created: $SignaturePath"
  }

  # Guarda una copia estable para que el build 0.6.2 no la pise
  $ArtifactDirectory = Join-Path `
    $PSScriptRoot `
    "..\updater-test-artifacts\$BaselineVersion"

  New-Item -ItemType Directory -Force $ArtifactDirectory | Out-Null

  # Copia el baseline firmado al directorio estable de pruebas
  Copy-Item $InstallerPath $ArtifactDirectory -Force
  Copy-Item $SignaturePath $ArtifactDirectory -Force

  Write-Host ""
  Write-Host "PASS Beat Galer $BaselineVersion signed updater baseline created."
  Write-Host "Installer: $InstallerPath"
  Write-Host "Signature: $SignaturePath"
  Write-Host "Saved baseline: $ArtifactDirectory"
  Write-Host "Updater endpoint: $UpdaterEndpoint"
}
finally {
  # Limpia siempre los temporales del probe
  Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
  Remove-Item "$probeFile.sig" -Force -ErrorAction SilentlyContinue

  # Limpia todas las credenciales y configuraciones temporales
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:\BEATGALER_UPDATER_ENDPOINT -ErrorAction SilentlyContinue

  # Devuelve automaticamente el proyecto a la version que tenia antes del baseline
  $CurrentVersion = (Get-Content (Join-Path $PSScriptRoot "..\VERSION") -Raw).Trim()

  if ($CurrentVersion -ne $OriginalVersion) {
    Write-Host ""
    Write-Host "Restoring project version to $OriginalVersion..."

    npm run version:set -- $OriginalVersion

    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Could not automatically restore project version to $OriginalVersion."
    }
  }
}