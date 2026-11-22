# catalog-lab — LAB de navegador y humo V1

Cloud real (`cloud-server/server.js`) + gateway Telegram **FAKE** en memoria + PostgreSQL efímero **propio** en WSL (puerto 54339, `/tmp/bg-catlab-browser`) + worker en proceso + siembra T12 de N beats en una sola ejecución del Cloud + Vite (POSTGRES y LEGACY). Todo en loopback. Evidencia **LAB**: no es proveedor real, CI ni gate.

Garantías: el Cloud arranca con cwd = `tmp/catalog-lab/state` que contiene un `.env` **vacío** (nunca lee `cloud-server/.env`); rechaza los puertos 5432/54329; credenciales aleatorias solo en `tmp/catalog-lab/state/lab.env.json` (ignorado por git).

## Comandos (desde la raíz del repo, Windows)

```
node scripts/catalog-lab/lab.cjs up [--seed 300] [--no-legacy]   # PG + bootstrap + Cloud + siembra + Vite (espera a que todo esté listo)
node scripts/catalog-lab/lab.cjs status
node scripts/catalog-lab/lab.cjs down [--keep-pg]               # mata procesos, borra DB/rol y el clúster WSL
node scripts/catalog-lab/lab.cjs detect                         # Chrome / Edge instalados

node scripts/catalog-lab/run-smoke-v1.mjs --list
node scripts/catalog-lab/run-smoke-v1.mjs [caso] [opciones de la sonda]
```

El runner usa `smoke` por defecto y ejecuta un caso por invocación. Requiere el LAB FAKE y Chrome/ChromeDriver locales. Reenvía las opciones al caso y devuelve código distinto de cero ante un error de ejecución o una medición `FAIL` o `ERROR`. Consulta el reporte para casos `NO EJECUTADO` y diagnósticos `INFO`. Usa una siembra fresca si el caso necesita portadas o hace cambios persistentes.

Salida por defecto en `tmp/catalog-lab-out/`, por caso. Las sondas de navegador comparten `browser-common.mjs` y las de selector de archivos reutilizan `file-inject.mjs`. V09 y V10 guardan sus resultados JSON, capturas, sumas SHA256 y el manifiesto de V09.

Casos `--only` de V09: `ENV GEOM SCROLL FOCUS QUERY INTERACTION MEDIA RESOURCES BULKTAGS ZOOM200 REDUCEDMOTION TOUCH LEGACY AUTH` (`MOUNT` siempre). Los 14 originales son MOUNT, GEOM, GEOM-DPR2, SCROLL, BORDER, FOCUS, QUERY, INTERACTION, DRAWER, MEDIA, RESOURCES, LEGACY-POSTGRES, AUTH y LEGACY-FLAGOFF. `BULKTAGS` es nuevo (UI real). `ZOOM200`, `REDUCEDMOTION` y `TOUCH` están **EMULADOS** por CDP y así se etiquetan (`(EMULADO)` en el id y `emulado: true`). Edge: `--browser edge`; si no está instalado o no hay driver → `NO EJECUTADO` con la razón. Lector de pantalla: siempre `NO EJECUTADO`.

Variables opcionales: `LAB_PG_PORT`, `LAB_CLOUD_PORT` (4140), `LAB_WEB_PORT` (1440), `LAB_WEB_LEGACY_PORT` (1441), `LAB_STATE_DIR`, `LAB_OUT_DIR`, `LAB_SEED_N`, `LAB_SYNTH_AUDIO=1` (MP3 sintético en vez de `tmp/gallery-test/*.mp3`).

Notas: el estado del gateway fake es en memoria → no reinicies el Cloud con la DB sembrada (usa `down` + `up`). Requiere WSL Ubuntu con PostgreSQL 18 (`/usr/lib/postgresql/18/bin`). La campaña V09 completa asume N=300 (`bgPage=100` se omite si N ≤ 120). Para V10 usa máquina exclusiva: la medición de frames compite con el resto de procesos.

## Índice de casos vigentes

| Caso | Sonda | Cobertura y condiciones |
| --- | --- | --- |
| `smoke` | `probe-smoke-v1.mjs` | Recorrido básico de V1. Siembra de al menos 30 beats. |
| `account-billing` | `probe-account-billing.mjs` | Settings, cuenta y degradación sin proveedor de pagos. |
| `add-beat` | `probe-add-beat.mjs` | Revisión, renombrado, cancelación, subidas, rating, errores y reproducción. |
| `artwork-remove` | `probe-artwork-remove.mjs` | Desvinculación de portada, persistencia, conflicto e invariantes SQL del LAB. |
| `audit` | `probe-audit.mjs` | Descarga, PROJECT por arrastre, papelera e importación WAV. |
| `chrome-geometry` | `probe-chrome-geometry.mjs` | Geometría de la barra superior y Tag Bar a varios anchos. Diagnóstico. |
| `drop-beat` | `probe-drop-beat.mjs` | Arrastre al catálogo, revisión y reproducción. |
| `drop-visuals` | `probe-drop-visuals.mjs` | Indicadores al arrastrar, reemplazo e importación por tipo. |
| `e79` | `probe-e79.mjs` | Caché de portadas, estrellas, orden con subidas, audio y MAIN. Requiere portadas visibles. |
| `e80` | `probe-e80.mjs` | Limpieza de caché, progreso y estabilidad de tarjetas. La comprobación `UPLOAD-MULTI-CARDS-STABLE` presenta fallos intermitentes conocidos. |
| `e86-import` | `probe-e86-import.mjs` | Rating ID3 al revisar, importar y descargar. Requiere el MP3 local de la sonda. Usa `--out` distinto de Add beat si conservas ambas evidencias. |
| `first-block-cases` | `probe-first-block-cases.mjs` | Copia local del primer bloque, revalidación, aislamiento de cuentas y cuota. |
| `first-card` | `probe-first-card.mjs` | Tiempos de primer bloque y primera tarjeta con y sin IndexedDB. Diagnóstico. |
| `first-play` | `probe-first-play.mjs` | Primer play y precalentamiento en frío y caliente. |
| `mse-stream` | `probe-mse-stream.mjs` | Diagnóstico E71 de streaming MSE con red simulada. Usa `mse-probe-entry.ts` y `mse-probe-accountgate-stub.ts`; resultados crudos en `tmp/e71-mse/results.json`. |
| `section61` | `probe-section61.mjs` | WAV y metadatos en Drawer, portada y operaciones pendientes. |
| `startup-profile` | `probe-startup-profile.mjs` | Perfil CPU hasta que la Gallery queda interactiva. Diagnóstico. |
| `url` | `probe-url.mjs` | URL corta de Gallery, persistencia de orden y enlace antiguo. |
| `v09` | `v09-run.mjs` | Navegación, geometría, accesibilidad, medios y sesión. Admite `--only` y `--skip`. |
| `v10` | `v10-browser.mjs` | Retroceso, scroll y soak. Admite `--duration-min`, `--sample-sec`, `--skip` y `--no-gc`. |

## Herramientas de apoyo y sondas fuera del runner

| Estado | Archivos | Alcance |
| --- | --- | --- |
| Vigente, infraestructura | `lab.cjs`, `lab-env.cjs`, `lab-bootstrap.cjs`, `lab-preload.cjs`, `pg-start.sh`, `pg-stop.sh` | LAB, siembra, gateway FAKE y PostgreSQL efímero propio. |
| Obsoleta, conservada | `bump-revision.mjs`, `probe-name-uniqueness.mjs` | Usan capacidad y PUT de bytes por Cloud retirados en E77. |
| Obsoleta, conservada | `probe-playbar-next.mjs`, `probe-purge-hold.mjs` | Dependen de `bump-revision.mjs` para preparar parte del escenario. |
| Obsoleta, conservada | `probe-ui-polish.mjs`, `probe-project-merge.mjs` | Inyectan fallos sobre rutas de bytes de E77 retiradas. Se conservan sus aserciones completas. |
| Obsoleta, conservada | `real-api.mjs`, `real-seed.mjs`, `real-purge.mjs`, `probe-download-all.mjs` | La preparación por `real-api.mjs` requiere capacidades de subida, PUT PROJECT o URLs de bytes antiguas. |
| Retirada | `real-integrity.mjs`, `real-faults.mjs` | E77 retiró las capacidades, PUT y lecturas por Cloud de las que dependían. El FAIL de arnés está registrado en E87 de [EVIDENCIA.md](../../docs/plans/catalogo-postgresql/EVIDENCIA.md). |
| Vigente, proveedor real autorizado | `probe-e2e-ui.mjs`, `probe-real-audio.mjs`, `real-preflight.cjs`, `real-preload.cjs`, `real-cleanup.cjs`, `real-resume-probe.cjs` | Campañas de proveedor separadas y sujetas a autorización. El experimento de reanudación corresponde a E77. |

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
node scripts/catalog-lab/run-smoke-v1.mjs smoke; $LASTEXITCODE            # 0 = PASS
$env:SMOKE_PLAY_SELECTOR='[data-no-existe]'; node scripts/catalog-lab/run-smoke-v1.mjs smoke; $LASTEXITCODE   # mutación: STEP 4 FAIL, código 1
Remove-Item Env:SMOKE_PLAY_SELECTOR
node scripts/catalog-lab/lab.cjs down                                  # siempre
```

Git Bash (`MSYS_NO_PATHCONV=1` evita que `LAB_PG_DIR` se reescriba a una ruta de Windows):
```
export MSYS_NO_PATHCONV=1 TEMP='E:\777\tmp' TMP='E:\777\tmp' DIRECT_DIAGNOSTICS_DIR='E:\777\tmp\diag' \
  LAB_PG_PORT=54359 LAB_CLOUD_PORT=4190 LAB_WEB_PORT=1490 LAB_STATE_DIR=tmp/catalog-lab-smoke LAB_PG_DIR=/tmp/bg-catlab-smoke LAB_SYNTH_AUDIO=1
node scripts/catalog-lab/lab.cjs up --no-legacy --seed 30
node scripts/catalog-lab/run-smoke-v1.mjs smoke; echo $?
SMOKE_PLAY_SELECTOR='[data-no-existe]' node scripts/catalog-lab/run-smoke-v1.mjs smoke; echo $?
node scripts/catalog-lab/lab.cjs down
```

## Primer play en frío y en caliente (`probe-first-play.mjs`) — LAB con dobles, no latencia real

Línea base repetible para tocar el precalentamiento del login. Mide por repetición: (1) instante (ms) de creación de cada `Worker`, de cada WebSocket del hilo principal, de la primera petición al doble `/lab-telegram` y de `/catalog/v1/direct/*`, y qué módulos se cargaron antes del clic; (2) ms desde el clic en play hasta que `currentTime` avanza. **Frío** = perfil de Chrome nuevo (caché HTTP e IndexedDB vacías) + login + Gallery + clic (instantes relativos al envío del login y al login confirmado). **Caliente** = mismo perfil ya usado, recarga con sesión recordada, mismo beat (instantes relativos al inicio de la carga). Tras `FP_SETTLE_MS` (2000) de «Gallery lista». Mediana y p90 (nearest-rank). Limitaciones: Vite dev (módulos sueltos), Telegram FAKE (en el LAB el puerto Direct B es el doble HTTP `catalogLabDirectPort`, no abre MTProto), solo Workers/WebSockets del hilo principal. Mismo preflight que el humo V1 (exige gateway FAKE, Chrome/driver locales, sin descargas). Salida: `RUN`/`TABLE`/`FIRST-PLAY PASS|FAIL`, código 1 si falla alguna repetición o hay <5 válidas de cada tipo, y JSON crudo en `tmp/catalog-lab-out/first-play/` (no versionado).

Git Bash (puertos propios; el primer `up` tras arrancar WSL puede dar `ECONNREFUSED` en el bootstrap: repetir `up`; `down` siempre):
```
export MSYS_NO_PATHCONV=1 TEMP='E:\777\tmp' TMP='E:\777\tmp' DIRECT_DIAGNOSTICS_DIR='E:\777\tmp\diag' \
  LAB_PG_PORT=54369 LAB_CLOUD_PORT=4200 LAB_WEB_PORT=1500 LAB_STATE_DIR=tmp/catalog-lab-firstplay LAB_PG_DIR=/tmp/bg-catlab-firstplay LAB_SYNTH_AUDIO=1
node scripts/catalog-lab/lab.cjs up --no-legacy --seed 30
node scripts/catalog-lab/run-smoke-v1.mjs first-play; echo $?                 # FP_COLD=6 FP_HOT=8 por defecto; 0 = PASS
FP_PLAY_SELECTOR='[data-no-existe]' FP_COLD=1 FP_HOT=1 node scripts/catalog-lab/run-smoke-v1.mjs first-play; echo $?   # mutación: FAIL, código 1
node scripts/catalog-lab/lab.cjs down
```
