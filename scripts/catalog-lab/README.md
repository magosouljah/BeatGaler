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
