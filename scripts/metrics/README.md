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
Informativos: CI los publica como artefacto `metrics` y nunca bloquea. El trinquete bloqueante llegará en M8.
