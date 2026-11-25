# scripts/metrics — métricas de solo lectura

Miden el repo sin escribir nada en él (solo `git ls-files` y lectura de archivos rastreados). Salida TSV por stdout. Uso: `node scripts/metrics/<script>.mjs <ruta-repo> [modo]`.

- `metrics.mjs` — tabla global (conteos, líneas, E/C/… por área). `node scripts/metrics/metrics.mjs . > metrics.tsv`.
- `classify-tests.mjs` — clasifica pruebas: comportamiento vs. inspección de texto fuente (`summary`|detalle).
- `cloud-reach.mjs` / `src-reach.mjs` — alcance (accesibilidad por imports) de Cloud y Web desde sus entradas; módulos sin alcanzar.
- `trace-files.mjs` — recorre saltos de importación desde archivos dados (`list` para listarlos).
- `refs.mjs` — inventario de herramientas (scripts, deploy, …) y cuántos archivos las referencian.
- `npm-scripts.mjs` — scripts de npm y quién los referencia.
- `pr-checks.mjs` — comprobaciones de un diff `base..head` (por defecto `main..HEAD`).
- `static-guards.mjs` — guardas de texto fuente y a qué workflow pertenecen.
- `lib.mjs` — utilidades comunes.

`refs.mjs` excluye `scripts/metrics/` de sus objetivos y referencias, para que las herramientas no se cuenten a sí mismas.
CI publica las tablas como artefacto informativo `metrics`, incluso si el trinquete falla.

`node scripts/metrics/ratchet.mjs .` comprueba los umbrales y los archivos F/M contra la línea base. Una mejora avisa «actualiza el baseline» y solo falla si se usa `--strict-improve`. Las rutas F/M iniciales quedan registradas en el baseline. Una guarda estática intencional nueva requiere una entrada nominal en `static-guards.allowlist.txt` y sigue contando en F+M.

`--against <ref>` lee el baseline histórico con `git show` y rechaza aumentos de umbrales, umbrales eliminados o altas en el conjunto inicial de archivos F/M. CI usa el SHA base del PR o el SHA anterior al push. En un push inicial de rama o en una ejecución manual usa `HEAD^`. Una referencia anterior a la incorporación del trinquete permite su primera instalación.
- `identity-cost.cjs` — (M7.4-char) mide lecturas/análisis completos del almacén de identidad por petición autenticada (json y archivo virtual PG), sin base de datos: `node scripts/metrics/identity-cost.cjs [10,1000,10000] [iteraciones]`. Escribe solo en el directorio temporal.
