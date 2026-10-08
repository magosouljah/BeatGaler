# Fase 1 — cierre de evidencia (2026-09-19)

## Estado auditado

- Rama: `stage1/real-multi-account-e2e`.
- HEAD inicial/final de la auditoría: `87efc476690cc4612d96ee6bd5bcd34d7f6f4177`.
- Remoto: `origin/stage1/real-multi-account-e2e` apunta al mismo SHA tras `git fetch --all --prune`.
- Los artefactos citados viven en `tmp/` y son locales/ignorados; no contienen contraseña de cohort, cookies, CSRF, tokens ni credenciales Direct permanentes.

## Matriz

Los estados `FALLÓ` indican que el requisito de evidencia de Fase 1 no se cumplió; no afirman por sí solos que el producto sea incorrecto cuando falta una prueba.

- `COMPROBADO` — multi-cuenta Web → Cloud → Direct, 7 cuentas, incluyendo autenticación aislada, usuarios/vaults/identidades Direct distintas, lectura autoritativa, playback, upload, edición de metadata, MASTER MP3, Reload y aislamiento posterior. Artefacto: `tmp/stage1-library-first-7acct-87efc47.json`; SHA `87efc476`; escenario mixto de siete cuentas.
- `COMPROBADO` — transferencia WAV de 64 MiB mientras las otras seis cuentas siguieron activas, seguida de Reload autoritativo y aislamiento. Mismo artefacto; `mixed_large_transfer: PASS`.
- `COMPROBADO` — ráfaga simultánea de 10 perfiles reales: auth, biblioteca autoritativa, usuarios/vaults Direct únicos, fixture upload, Reload simultáneo y playback real. Artefacto: `tmp/stage1-10-accounts-87efc47.json`; SHA `87efc476`; `requested_account_count: 10`.
- `FALLÓ` — recorrido individual completo: no hay evidencia E2E de seek ni de logout/cierre seguido de relogin y lectura autoritativa final. El playback real está probado, pero no esos dos pasos.
- `FALLÓ` — integridad de descargas: MASTER MP3 se materializa por UI, pero no hay hash de WAV/ZIP ni validación separada de decodificación y tags MP3 en la descarga producida.
- `FALLÓ` — aislamiento ofensivo real: la aislación normal y el fencing unitario existen, pero no hay E2E que intente, desde otra cuenta, reutilizar un id de sesión/operación/archivo ni leer/modificar/finalizar el recurso ajeno.
- `FALLÓ` — fallos inducidos por una cuenta: no hay E2E multi-cuenta de corte de red durante upload, cierre abrupto de navegador, logout y reconexión que pruebe simultáneamente continuidad de las demás cuentas y liberación de recursos.
- `FALLÓ` — rotación de roles: la reproducción diagnóstica tuvo una sola ronda y marcó `mixed_role_rotation: SKIPPED`; el soak de 30 min no llegó a completar la primera ronda.
- `FALLÓ` — soak de 30 min: el artefacto `tmp/stage1-mixed-soak-30m-7-accounts-90ab0df.json` terminó con `STAGE1_MIXED_SOAK_ROUND_FAILED` en ronda 1 (Account 02 no probó progreso de playback; Account 04 no persistió metadata tras Reload). No se debe presentar como PASS funcional.
- `FALLÓ` — presupuesto de rendimiento: en la reproducción de siete cuentas del SHA auditado, `mixed_hot_library_budget` y `mixed_first_audio_budget` fallaron P1. El workload funcional sí finalizó.
- `FALLÓ` — 10 cuentas completas: la infraestructura ejecutó las 10; no es un bloqueo de Chrome/WebDriver. La corrida falló P1 en `metadata_edit_persistence` (Account 03: el editor no cerró tras guardar), dejando download y Trash bloqueados por orden del runner.
- `PENDIENTE POR INFRAESTRUCTURA` — arranque frío/reinicio controlado de Cloud y observación de pool/sesiones/reapertura a través de ese reinicio. No hay artefacto de esa condición y reiniciar el servicio Cloud compartido no se hizo durante esta auditoría.

## Pruebas ejecutadas en esta auditoría

- `node --test tests/e2e-web/stage1-auth-observer.test.mjs tests/e2e-web/stage1-cloud-timing.test.cjs tests/e2e-web/stage1-health-validation.test.mjs tests/e2e-web/stage1-vite-watch.test.mjs tests/e2e-web/stage1-wdio-profile-isolation.test.mjs` — 11/11 PASS. Valida instrumentación sanitizada, health, watcher y perfiles Chrome aislados.
- `node cloud-server/tests/direct-index-operation-document-context.test.cjs` — PASS. Cobertura unitaria de fencing de operaciones Direct entre documentos/dispositivos; no sustituye E2E ofensivo entre cuentas.
- `node cloud-server/tests/sensitive-auth-capability-revocation.test.cjs` — 3/3 PASS, incluido orden de revocación en logout; no sustituye logout/relogin real multi-cuenta.
- `node scripts/run-stage1-real-multi-account-e2e.mjs --accounts 10` — FAIL P1, pero prueba que la configuración local levantó diez navegadores reales y alcanzó las invariantes descritas arriba. Artefacto archivado: `tmp/stage1-10-accounts-87efc47.json`.

## Métricas observadas

Fuente: `tmp/stage1-library-first-7acct-87efc47.json`, corrida diagnóstica de 7 cuentas, una ronda de 60 s que duró 74,757 ms.

- First audio: 10 muestras; p95/máximo 2,002 ms; presupuesto <=2,000 ms; `FALLÓ` por 2 ms.
- Hot library: 17 muestras; p95/máximo 36,951 ms; presupuesto <=5,000 ms; `FALLÓ` P1.
- Upload: 1 muestra; p95/máximo 74,491 ms (WAV de 64 MiB).
- Download MASTER MP3: 4 muestras; p95/máximo 5,313 ms.
- Metadata edit: 3 muestras; p95/máximo 8,982 ms.
- Metadata + Reload: 3 muestras; p95/máximo 10,803 ms.
- Reload: 7 muestras; p95/máximo 13,279 ms.
- Operación de playback: 5 muestras; p95/máximo 4,079 ms; spread de inicio p95/máximo 77 ms.
- Cuenta 03 en Reload final: `refresh_command_ms=1,685`, `library_after_refresh_ms=35,266`, `library_ready_ms=36,951`.

La corrida completa a diez no alcanza un resumen de métricas posterior porque se detuvo al guardar metadata. Sí midió diez reproducciones reales concurrentes: spread de inicio 5,655 ms, por encima del objetivo blando de 2,000 ms, sin que ese objetivo sea una aceptación dura en el runner normal.

## Blockers y reproducción

1. P1 rendimiento: `STAGE1_MIXED_SOAK_BUDGET_MISS` en siete cuentas. Reproducir con `STAGE1_MIXED_WORKLOAD=1`, `STAGE1_SOAK_MINUTES=1`, `STAGE1_SOAK_ROTATIONS=1`, `node scripts/run-stage1-real-multi-account-e2e.mjs --accounts 7`. No se ajustaron presupuestos.
2. P1 metadata a diez cuentas: ejecutar `node scripts/run-stage1-real-multi-account-e2e.mjs --accounts 10`; la evidencia capturada falla con `Account 03 metadata editor did not close after save` después de los pasos de startup, upload, Reload y playback.
3. P1 soak de 30 min: la ronda 1 de `tmp/stage1-mixed-soak-30m-7-accounts-90ab0df.json` falló playback de Account 02 y persistencia de metadata de Account 04. Hace falta aislarlo antes de usar el soak como aceptación.

## Qué falta exactamente

- Un E2E de seek y logout/cierre → relogin → lectura autoritativa final.
- Captura de archivos descargados: SHA-256 para WAV/ZIP, y validación independiente de audio y tags para MP3.
- E2E ofensivo cross-account para ids de sesión, operación y archivo, con respuestas de rechazo y verificación de que el contenido ajeno no se filtra.
- E2E de fallo inducido de una cuenta (red/upload, cierre abrupto, logout, reconexión), comprobando las otras cuentas, leases/operaciones y contenido confirmado.
- Siete rondas rotadas y un soak real de 30 min que termine funcionalmente; sus presupuestos se informan por separado.
- Corrección o caracterización reproducible del fallo de metadata a 10 cuentas, y después completar download/Trash a 10.
- Ejecución controlada de arranque frío/reinicio de Cloud con evidencia de pool, sesiones y reapertura.

## Veredicto

`FASE 1 TODAVÍA NO CERRABLE`.

La evidencia fuerte llega a siete cuentas funcionales bajo workload mixto y a diez cuentas para startup/reload/playback, pero faltan varios requisitos explícitos y hay tres fallos P1 reproducibles o registrados. No se recomienda más optimización especulativa de `hot_library` durante la captura de evidencia.

## SOL_ESCALATION

No aplica todavía. Los problemas están localizados y reproducibles (presupuestos de biblioteca, metadata a diez cuentas y soak); la siguiente intervención debe añadir/ejecutar la instrumentación E2E faltante y aislar esos casos, no una investigación arquitectónica abierta.
