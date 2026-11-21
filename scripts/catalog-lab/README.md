# catalog-lab — LAB de navegador (V09 / V10)

Cloud real (`cloud-server/server.js`) + gateway Telegram **FAKE** en memoria + PostgreSQL efímero **propio** en WSL (puerto 54339, `/tmp/bg-catlab-browser`) + worker en proceso + siembra T12 de N beats en una sola ejecución del Cloud + Vite (POSTGRES y LEGACY). Todo en loopback. Evidencia **LAB**: no es proveedor real, CI ni gate.

Garantías: el Cloud arranca con cwd = `tmp/catalog-lab/state` que contiene un `.env` **vacío** (nunca lee `cloud-server/.env`); rechaza los puertos 5432/54329; credenciales aleatorias solo en `tmp/catalog-lab/state/lab.env.json` (ignorado por git).

## Comandos (desde la raíz del repo, Windows)

```
node scripts/catalog-lab/lab.cjs up [--seed 300] [--no-legacy]   # PG + bootstrap + Cloud + siembra + Vite (espera a que todo esté listo)
node scripts/catalog-lab/lab.cjs status
node scripts/catalog-lab/lab.cjs down [--keep-pg]               # mata procesos, borra DB/rol y el clúster WSL
node scripts/catalog-lab/lab.cjs detect                         # Chrome / Edge instalados

node scripts/catalog-lab/v09-run.mjs [--browser chrome|edge] [--out DIR] [--only ENV,GEOM,...] [--skip ID] [--headed]
node scripts/catalog-lab/v10-browser.mjs [--duration-min 20] [--sample-sec 10] [--browser chrome|edge] [--out DIR] [--skip SCROLLBACK|SOAK] [--no-gc]
```

Salida por defecto en `tmp/catalog-lab-out/{v09,v10}/` (no versionado): `*-results.json`, capturas `.png`, `v09-manifest.json` y `SHA256SUMS`.

Casos `--only` de V09: `ENV GEOM SCROLL FOCUS QUERY INTERACTION MEDIA RESOURCES BULKTAGS ZOOM200 REDUCEDMOTION TOUCH LEGACY AUTH` (`MOUNT` siempre). Los 14 originales son MOUNT, GEOM, GEOM-DPR2, SCROLL, BORDER, FOCUS, QUERY, INTERACTION, DRAWER, MEDIA, RESOURCES, LEGACY-POSTGRES, AUTH y LEGACY-FLAGOFF. `BULKTAGS` es nuevo (UI real). `ZOOM200`, `REDUCEDMOTION` y `TOUCH` están **EMULADOS** por CDP y así se etiquetan (`(EMULADO)` en el id y `emulado: true`). Edge: `--browser edge`; si no está instalado o no hay driver → `NO EJECUTADO` con la razón. Lector de pantalla: siempre `NO EJECUTADO`.

Variables opcionales: `LAB_PG_PORT`, `LAB_CLOUD_PORT` (4140), `LAB_WEB_PORT` (1440), `LAB_WEB_LEGACY_PORT` (1441), `LAB_STATE_DIR`, `LAB_OUT_DIR`, `LAB_SEED_N`, `LAB_SYNTH_AUDIO=1` (MP3 sintético en vez de `tmp/gallery-test/*.mp3`).

Notas: el estado del gateway fake es en memoria → no reinicies el Cloud con la DB sembrada (usa `down` + `up`). Requiere WSL Ubuntu con PostgreSQL 18 (`/usr/lib/postgresql/18/bin`). La campaña V09 completa asume N=300 (`bgPage=100` se omite si N ≤ 120). Para V10 usa máquina exclusiva: la medición de frames compite con el resto de procesos.

## Sondas de navegador (Chrome aislado del LAB, no el del propietario)

- `node scripts/catalog-lab/probe-add-beat.mjs`: flujo real de «Add beat» (nombre válido, nombre > 50 con paso de renombrado, guardado en PostgreSQL por la API, reproducción desde el proveedor FAKE). El selector nativo de archivos se sustituye por un `File` inyectado.
- `node scripts/catalog-lab/probe-chrome-geometry.mjs`: geometría de la barra superior (Tag Bar, sombra, guía y toolbar) a 1440/1920/1024/390 px.

Nota: la línea `[catalog] ... gateway=none` del Cloud se refiere al gateway real por entorno (apagado en el LAB). En el LAB el gateway **FAKE** va inyectado por `lab-preload.cjs` (ver `[lab] preload active: Telegram FAKE` en `cloud.log`).

## Humo V1 (`probe-smoke-v1.mjs`) — LAB con dobles, no proveedor real

Landing → login (cuenta del LAB) → Gallery sembrada → reproducir (`currentTime` avanza) → «Add beat» (File inyectado, `file-inject.mjs`; tarjeta del ID creado) → editar en el Drawer (persiste tras recargar) → papelera (ID exacto fuera de la lista activa y dentro de TRASH; HTTP 200 + esquema obligatorios). Imprime `STEP <id> PASS|FAIL <ms> <causa>`; código 1 si falla alguno.

Preflight (antes de abrir navegador): aborta si `cloud.log` no contiene `[lab] preload active: Telegram FAKE` o el doble `/lab-telegram` (puerto Cloud+5) no escucha; exige Chrome y ChromeDriver **locales** (`SMOKE_CHROME`, `SMOKE_CHROMEDRIVER`, o detección: Chrome en Archivos de programa y `%TEMP%\chromedriver\*\chromedriver-win64\chromedriver.exe`); no descarga nada.

PowerShell (variables fijadas una vez para up, sonda, mutación y down):
```
$env:TEMP='E:\777\tmp'; $env:TMP='E:\777\tmp'; $env:DIRECT_DIAGNOSTICS_DIR='E:\777\tmp\diag'
$env:LAB_PG_PORT='54359'; $env:LAB_CLOUD_PORT='4190'; $env:LAB_WEB_PORT='1490'; $env:LAB_STATE_DIR='tmp/catalog-lab-smoke'; $env:LAB_PG_DIR='/tmp/bg-catlab-smoke'; $env:LAB_SYNTH_AUDIO='1'
# $env:SMOKE_CHROMEDRIVER='C:\ruta\chromedriver.exe'   # si no está en %TEMP%\chromedriver
node scripts/catalog-lab/lab.cjs up --no-legacy --seed 30
node scripts/catalog-lab/probe-smoke-v1.mjs; $LASTEXITCODE            # 0 = PASS
$env:SMOKE_PLAY_SELECTOR='[data-no-existe]'; node scripts/catalog-lab/probe-smoke-v1.mjs; $LASTEXITCODE   # mutación: STEP 4 FAIL, código 1
Remove-Item Env:SMOKE_PLAY_SELECTOR
node scripts/catalog-lab/lab.cjs down                                  # siempre
```

Git Bash (`MSYS_NO_PATHCONV=1` evita que `LAB_PG_DIR` se reescriba a una ruta de Windows):
```
export MSYS_NO_PATHCONV=1 TEMP='E:\777\tmp' TMP='E:\777\tmp' DIRECT_DIAGNOSTICS_DIR='E:\777\tmp\diag' \
  LAB_PG_PORT=54359 LAB_CLOUD_PORT=4190 LAB_WEB_PORT=1490 LAB_STATE_DIR=tmp/catalog-lab-smoke LAB_PG_DIR=/tmp/bg-catlab-smoke LAB_SYNTH_AUDIO=1
node scripts/catalog-lab/lab.cjs up --no-legacy --seed 30
node scripts/catalog-lab/probe-smoke-v1.mjs; echo $?
SMOKE_PLAY_SELECTOR='[data-no-existe]' node scripts/catalog-lab/probe-smoke-v1.mjs; echo $?
node scripts/catalog-lab/lab.cjs down
```
