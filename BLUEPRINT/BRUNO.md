# BRUNO

## Recordatorios personales para dirigir BeatGaler.

- **Stupid Simple.** Si algo empieza a necesitar demasiadas capas, reglas o excepciones, buscar una forma más simple.
- **Volver a los dos flujos centrales.** Construir/organizar existe para que encontrar/escuchar/descargar sea exactamente como el usuario quiere.
- **V1 tiene frontera.** Una idea nueva no entra automáticamente; si no hace falta para la V1 definida, va después.
- **Un problema importante a la vez.** Terminar limpio antes de abrir otro frente cuando sea posible.
- **“Funciona” no significa “terminado”.** También debe conservar lo importante, cubrir sus riesgos y no dejar basura o caminos duplicados.
- **No conservar complejidad por trabajo invertido.** Si una arquitectura claramente mejor reemplaza a la anterior, cambiarla conscientemente.
- **Architecture solo guarda decisiones que realmente quieres conservar.** No experimentos ni planes temporales.
- **La IA ayuda a entender, decidir e implementar; tú decides qué debe ser BeatGaler.**
- **El objetivo es terminar BeatGaler V1, no perfeccionar el sistema de trabajo.**



## comandos 

### 1. PostgreSQL + Cloud — WSL

```bash
service postgresql start # Arranca PostgreSQL.

pg_isready -h 127.0.0.1 -p 5432 -d beatgaler_cloud_dev -U beatgaler_dev # Comprueba que PostgreSQL acepta conexiones.

cd /mnt/e/777/app/beatvault/cloud-server # Entra al Cloud.

node --env-file=.env server.js # Arranca BeatGaler Cloud.
```

Debe aparecer:

```text
[control-plane] authority=postgres claim-coordinator=postgres direct-capabilities=postgres
```

### 2. Comprobar Cloud — otra terminal WSL

```bash
curl -s http://127.0.0.1:4000/readyz
# Debe mostrar postgres: ready.

curl -s http://127.0.0.1:4000/healthz
# Debe mostrar status: live.
```

### 3. Desktop — PowerShell Windows

```powershell
cd E:\777\app\beatvault
# Entra al repo.

$env:BEATGALER_CLOUD_API="http://127.0.0.1:4000"
# Fuerza el Cloud local para las partes Desktop que usan esta variable.

pwsh -NoProfile -File .\scripts\run-tauri.ps1 dev
# Arranca BeatGaler Desktop con PowerShell 7.
```

```powershell caca
$pid1420 = (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue).OwningProcess # Obtiene únicamente el proceso que está sirviendo localhost:1420.
if ($pid1420) { Stop-Process -Id $pid1420 -Force } # Mata únicamente el servidor viejo que ocupa el puerto 1420.

cd E:\777\app\beatvault # Entra al repositorio correcto.
git status -sb # Confirma visualmente qué branch tienes activa.
git rev-parse --short HEAD # Confirma exactamente qué commit vas a ejecutar.

Remove-Item -Recurse -Force node_modules\.vite -ErrorAction SilentlyContinue # Borra la caché compilada de Vite.
npm run dev -- --force # Inicia Vite reconstruyendo sus dependencias y módulos.
```




### 3. WEB - PowerShell Windows

```powershell
cd E:\777\app\beatvault # Entrar al proyecto
# npm ci # Reinstala exactamente las dependencias del frontend, incluyendo Vite.


npm run dev # Abrir el frontend web en modo desarrollo
```