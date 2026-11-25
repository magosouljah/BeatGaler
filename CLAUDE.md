# BeatGaler — Instrucciones para Claude Code

**Actualizado:** 2026-11-21 · **Código de referencia:** `main@ad8f8d0` · Sustituye al `CLAUDE.md` de la migración (9–20 nov; copia en `E:\777\app\BeatGaler-plan-backups\20261121-limpieza-preparacion\`, en git).

## 1. Qué es BeatGaler V1 hoy

Aplicación Web para organizar beats (metadatos, tags, carátulas, reproducción, descargas) con cuentas y planes de pago. **En producción (`beatgaler.com`) desde el 20-nov-2026 sobre catálogo PostgreSQL nativo.** El INDEX de Telegram fue **retirado del runtime** (T25/E89, merge `1a4b48c`).

- **Web** (`src/`, Vite/React): `main.tsx → WebExperience → AuthExperienceGate → Gallery PostgreSQL` (`src/features/library/catalog/`, build con `VITE_CATALOG_API_ENABLED=true`).
- **Cloud** (`cloud-server/`, Node/Express): `server.js` + `server-core.js`; auth/sesiones/CSRF, control-plane, pagos (Polar), `/catalog/v1/*` (`cloud-server/catalog/`).
- **Worker** separado (`catalog-worker.js` → `catalog/worker.js`): verificación/commit de transferencias, purga. Sin él las subidas no terminan.
- **Autoridad por dato:** PostgreSQL = identidad, catálogo, versiones, permisos, operaciones, referencias, derechos. **Telegram = solo bytes** (audio, PROJECT, portada, MAIN). Polar = hechos comerciales. Navegador = UI y cachés (IndexedDB).
- **Ningún byte de archivo pasa por el Cloud:** viajan navegador ↔ Telegram por **Direct B** (Worker `@mtcute/web`); el Cloud emite capacidades y confirma metadatos.
- **Desktop/Tauri (`src-tauri/`) y `DESIGN/`** están fuera de alcance y aislados; no borrarlos sin decisión explícita.

Mapas: [ARQUITECTURA.md](docs/plans/catalogo-postgresql/ARQUITECTURA.md) (módulos del catálogo) y la entrada única de conocimiento `E:\777\app\BeatGaler-arq\README.md` (sistemas, flujos, P01–P07, plan de limpieza, línea base de pruebas).

## 2. Fuentes vigentes y precedencia

1. Restricciones explícitas del propietario y seguridad.
2. **El código en el SHA actual** (verdad técnica final; los informes son guía).
3. Estado operativo: [CIERRE-LIVE-2026-11-20.md](docs/plans/catalogo-postgresql/CIERRE-LIVE-2026-11-20.md), [PENDIENTES-POST-LIVE-2026-11-20.md](docs/plans/catalogo-postgresql/PENDIENTES-POST-LIVE-2026-11-20.md), [DEPLOY-AWS.md](docs/operations/DEPLOY-AWS.md).
4. UX aprobada: C12-r4 ([C12-DECISION-RECORD.md](docs/plans/catalogo-postgresql/C12-DECISION-RECORD.md), `C12-V00-CIERRE-20261107.md`). UI/diseño: [AGENTS.md](AGENTS.md) y `BLUEPRINT/DESIGN-SYSTEM/README.md`.
5. Limpieza de arquitectura: [mapa Web y Cloud](docs/plans/catalogo-postgresql/ARQUITECTURA.md), [glosario](docs/GLOSSARY.md) y [decisiones M3–M4](docs/adr/0001-interfaces-m3-m4.md). Plan, informes y mapas de referencia en `BeatGaler-arq` (`README.md` → `mapa-v1/`, `panorama-main-20261120/`).
6. **Históricos** (consultar solo ante regresiones o dudas de diseño): NATIVO r2.1, TAREAS, matrices T/V, actas T00–T21, `ESTADO.md`/`EVIDENCIA.md` anteriores a E89. No reabrir fases ni reiniciar migraciones.

Ante contradicción material: registrarla, no elegir por intuición, no asumir PASS.

## 3. Roles

- **Propietario (Purp):** decide arquitectura y producto; autoriza operaciones reales, despliegues, borrados, push y cambios de credenciales. No programa: explicarle por responsabilidades y comportamiento, y traerle decisiones, no preguntas técnicas.
- **Dictamen técnico (D26):** Sol ya no es dependencia. El dictamen sensible lo da Opus con inteligencia ALTA más un segundo revisor independiente. Producto, producción y operaciones irreversibles siguen siendo del propietario.
- **Claude Code:** ejecutor. Inteligencia MEDIA por defecto; BAJA para tareas mecánicas; ALTA solo para arquitectura nueva o revisión crítica.

## 4. Estado y pendientes que no deben darse por cerrados

- **G2 NOT_PROVEN:** producción usa bots reutilizados sin rotar (`REUSED_UNROTATED`, riesgo aceptado por el propietario). **G3 pendiente.** El dictamen formal de G2/G3 lo da Opus ALTA con segundo revisor (D26); cerrarlos con riesgo residual es decisión del propietario. No declarar PASS con mocks.
- Flujos con sesión en producción: **NOT_PROVEN** (no hay cuenta de prueba controlada en producción).
- Eliminación física en Telegram **deshabilitada a propósito** (`BEATGALER_CATALOG_JOURNAL_DIR` sin configurar).
- Borrado de cuentas: proceso autorizado, durable y auditable; **no habilitar** sin decisión.
- **Limpieza de código:** M0–M5 ejecutadas en `local/limpieza-v1-int`, pendientes de integración a `main`. Evidencia con fakes y CI con PostgreSQL efímero. La limpieza sigue sin pruebas con proveedor real. G2 y G3 conservan el estado indicado arriba. Siguientes módulos solo con autorización.

## 5. Git y ramas

- GitHub: `main` (protegida) más ramas de revisión `local/**` publicadas con permiso; ramas antiguas archivadas como tags `archive/*`. Producción se despliega **solo desde `main`** con `bash scripts/aws/deploy.sh`.
- Trabajar en ramas locales `local/<tema>-<fecha>`. Commits solo cuando se pidan o estén autorizados; **push solo con permiso explícito**.
- **Prohibido sin autorización expresa:** push/merge a `main`, force-push, rebase, reset, clean, stash, borrar ramas/tags, despliegues.
- Preflight antes de editar: rama, HEAD, `git status`, diff de alcance. No incluir nunca `Claude outputs/`, imágenes del usuario ni secretos. No tocar `stash@{0}`, `backup/*` ni `archive/*`.
- Antes de editar documentos de plan: un respaldo único con SHA-256 en `E:\777\app\BeatGaler-plan-backups\`.

## 6. Seguridad operativa

- **No leer, copiar, mostrar ni registrar** `.env`, `.env.*`, credenciales ni secretos.
- **`cloud-server/` del checkout principal contiene credenciales reales ignoradas por git** (`.env`, `.env.telegram-test`, `master-session.txt`, `transport-bots.local.json` con Bot20). Ejecutar pruebas desde un **worktree limpio** o con el arnés `scripts/catalog-check.cjs` (entorno por allowlist + guard de red), nunca con variables heredadas.
- Sin autorización: nada de AWS, RDS, Telegram real, Polar real, bots, cuentas, chats ni producción. LAB real (Bot20/testborrar) solo con permiso.
- **Nunca** usar el clúster PostgreSQL de desarrollo de WSL (`18/main`, puerto 5432, `beatgaler_gallery_test`) para pruebas. Nunca ejecutar `postgres-live.integration.cjs`. Bases de prueba: solo efímeras propias o el service container de CI.
- `cloud-server/diagnostics/telegram-direct-control.txt` está versionado: fijar `DIRECT_DIAGNOSTICS_DIR` fuera del repo al probar; si se modifica, `git restore` antes de desplegar.
- No desactivar tests, checks ni guardas para forzar PASS; las pruebas nuevas miden comportamiento.

## 7. Invariantes que no se relajan

- PostgreSQL es la única autoridad del catálogo; **no volver a INDEX** (no existe rollback a INDEX).
- Ningún byte por el Cloud; integridad de envío **C7.8** (identidad persistida antes de enviar, sin reenvío a ciegas); los clientes **nunca** reciben `bot_token` en claro.
- Mutaciones: auth server-side, aislamiento por usuario, transacciones SQL breves, era/época/versión, idempotencia, control de concurrencia; ninguna espera de Telegram dentro de una transacción.
- Proteger catálogo, generaciones activas y referencias de archivos contra cascadas; `reset` no vacía bibliotecas; no borrar medios, mensajes ni INDEX históricos por autorización genérica.
- Un backup SQL **no** sustituye la copia de bytes de Telegram.
- Las guardas de cuentas se componen solo en `cloud-server/account-route-guards.js` (tabla única montada sobre la instancia en `server-core.js`); no se reasigna `express.application.*`.
- No tocar por simplificar sin pruebas y permiso: refs/purge, Direct/mtcute compartido, sesión y CSRF (incluido el `fetch` global único de `webFetchBoundary`), `server-core-auth-bridge-loader`, idempotencia, derechos pagados, guards SQL.
- **Preservar sin cambios visuales** Landing, Gallery virtualizada, BeatCards, Tag Bar y Playbar; Gallery consulta globalmente en PostgreSQL sin cargar la biblioteca en memoria.

## 8. Pruebas

- Línea base y comandos aislados: `E:\777\app\BeatGaler-arq\linea-base-20261121\LINEA-BASE.md`. Reutilizarla; repetir solo las suites afectadas por un cambio.
- `npm test` = `test:web` (typecheck, unit TS, component-dom, integration, `test:node`, `test:regressions:v1`) + `test:cloud` (`scripts/run-cloud-tests.mjs` + catálogo `unit`/`faults`). Sin Rust/Desktop ni guardas de release (`npm run test:regressions` completo las incluye).
- `scripts/run-cloud-tests.mjs` y `scripts/catalog-check.cjs` **se niegan** a ejecutarse si el checkout tiene credenciales/estado locales (hay módulos que los leen por ruta fija): usar un worktree limpio. Ambos dejan `dotenv` inerte y precargan el guard de red; el runner de Cloud bloquea además todo puerto PostgreSQL salvo la instancia verificada.
- Integración Cloud: `--integration` exige `BEATGALER_CLOUD_TEST_ADMIN_URL` (PG efímero en loopback, nunca el 5432 local) **y** `BEATGALER_CLOUD_TEST_INSTANCE_ID` igual al centinela `bg_test_lab.lab_identity` de esa instancia; sin centinela no toca nada, también con `CI=true`.
- CI: `.github/workflows/ci.yml` (Web + Cloud) y `catalog-checks.yml` (catálogo con PG efímero) en push a `main` y a ramas `local/**`.
- Catálogo: `node scripts/catalog-check.cjs unit|faults|T08|T11|T13` (local, sin DB). Las suites con `catalog-test-db` solo corren en CI (`catalog-checks`, descriptor fail-closed); no parchear el descriptor.
- Distinguir pruebas de comportamiento de las que solo inspeccionan texto fuente; las segundas no protegen una refactorización.
- Lo verificado en código ≠ verificado en funcionamiento; un PASS con fakes ≠ evidencia de proveedor real.

## 9. Evidencia, STOP y comunicación

- Registrar por tarea un resumen breve (SHA/rama, archivos, comandos, resultado). Catálogo: `docs/plans/catalogo-postgresql/ESTADO.md`/`EVIDENCIA.md`. Limpieza: `BeatGaler-arq`. Sin informes largos ni auditorías repetidas.
- **Detenerse y escalar** ante decisión de arquitectura/producto no aprobada, riesgo de integridad o seguridad, acceso a servicio real, prueba obligatoria que falla sin corrección segura, borrado/migración no autorizados o incompatibilidad contractual. Códigos: `STOP-BASE`, `STOP-ENV`, `STOP-TEST`, `STOP-DESIGN`, `STOP-CONTRACT`, `STOP-DATA`, `STOP-GATE`, `STOP-APPROVAL`.
- **Español, directo y muy breve.** Priorizar calidad e integridad con el menor consumo de tokens.
