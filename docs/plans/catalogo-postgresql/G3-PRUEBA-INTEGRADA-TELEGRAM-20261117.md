# G3 — Preparación de la prueba integrada PostgreSQL + Telegram de pruebas (2026-11-17)

**Estado:** documento de preparación. **No se ha usado ninguna credencial ni servicio real.** G2/T11 siguen NOT_PROVEN (E5 en revisión manual, E7 no ejecutado, sin dictamen de Sol); G3 sin dictamen; sin GO. La prueba integrada **no se ejecuta** sin las autorizaciones de §3.

## 1. Comprobaciones técnicas G3 en LOCAL (hechas con FAKE)

| Área | Evidencia |
| --- | --- |
| Gallery virtualizada, filtros, orden, selección global | CI T06/T08/T13/T16; LAB `probe-ui-polish` |
| Playbar (Next/Previous/Shuffle/auto-avance, conjunto obsoleto) | E55; LAB `probe-playbar-next` |
| Add beat con revisión (nombre/BPM/key/tags/portada, MP3 y WAV→MP3, PROJECT) | E59; LAB `probe-add-beat` 6/6 |
| Reemplazo por arrastre (audio, portada, PROJECT) | E54/E56; LAB `probe-drop-beat`, `probe-drop-visuals` |
| Download, papelera nativa, PROJECT con fusión por tipo | E58/E59/E60; LAB `probe-audit`, `probe-project-merge` |
| Nombres únicos (concurrencia real en PostgreSQL) | E60; LAB `probe-name-uniqueness` 11/11 |
| Cuentas/billing sin pagos reales | E59/E60; LAB `probe-account-billing` |
| Backup/restore a 500 beats (G4 parcial), rendimiento a 500 | E49, T20 |

**Siguen fuera de lo demostrable con FAKE:** comportamiento real del proveedor (límites, latencias, reconciliación por búsqueda, revocación de credenciales = G2), navegador Edge/lector de pantalla/zoom/táctil (manual del propietario, [V09-PRUEBA-MANUAL](V09-PRUEBA-MANUAL-20261113.md)), `pg_dump` real y destino de backups (G4), dictámenes de Sol.

## 2. Requisitos de la prueba integrada

**Entorno (aislado, nunca producción):** PostgreSQL 18 efímero propio (el LAB: `node scripts/catalog-lab/lab.cjs up`, WSL, puerto 54339) o la DB local de pruebas `beatgaler_gallery_test`; Cloud real (`cloud-server/server.js`) con `BEATGALER_CATALOG_NATIVE_ENABLED=true`, `BEATGALER_CATALOG_WORKER_ENABLED=true`, **`BEATGALER_CATALOG_GATEWAY_ENABLED=true`** (apagado por defecto), `BEATGALER_DEPLOYMENT_ENV` distinto de producción (en producción además exigiría `BEATGALER_CATALOG_G2_APPROVED=true` = `STOP-GATE`: **no** se activa), `BEATGALER_CATALOG_CURSOR_KEYS`, `BEATGALER_CATALOG_JOURNAL_DIR` y `BEATGALER_PROJECT_UPLOAD_TEMP_DIR` locales. Cuenta de prueba con biblioteca **nueva** (sin INDEX) y vault de pruebas.

**Telegram de pruebas (nombres, sin valores):** pool local de transporte con **solo** el bot de pruebas (Bot20, `transport-bots.local.json`), chat de vault de pruebas con exactamente MASTER + bot, cuenta MASTER de pruebas (`.env.telegram-test`: api_id, api_hash y sesión de prueba), descriptor `T11-SANDBOX` (TTL ≤ 24 h, `production:false`, sin credenciales) y `BEATGALER_T11_SANDBOX_APPROVAL`. Node en WSL: `/opt/beatgaler-node/node-v22.23.2-linux-x64/bin/node` con `family: 4` hacia `api.telegram.org`.

**Pendientes previos conocidos:** confirmar que producción no arrienda Bot20 (pool de la fábrica); el propietario borra a mano los mensajes 12–15 sobrantes de la corrida T11 en `testborrar`; E3/E7 sin ejecutar (E7 **no** se ejecuta: rota el token).

## 3. Autorizaciones necesarias (ninguna concedida a esta sesión para esta prueba)

1. **Propietario, por escrito y solo para la sesión:** usar Bot20, el chat `testborrar`/vault de pruebas y la cuenta MASTER de pruebas; crear y borrar mensajes de prueba solo del ledger (`catalog:v1 op=…`).
2. **Dictamen de Sol (GPT-6)** de que la prueba puede ejecutarse (G2 es suyo).
3. **Prohibido sin autorización adicional:** rotar o revocar tokens (E7), tocar el pool de producción, AWS, `main`, despliegues, borrar medios o chats, usar cuentas reales de usuarios.

## 4. Procedimiento corto (cuando existan las autorizaciones)

1. `git status` limpio en `local/landing-gallery-unificada` y HEAD = remoto; `node scripts/catalog-lab/lab.cjs down` por si hay un LAB previo.
2. Levantar PostgreSQL efímero y bootstrap de la biblioteca nativa con **gateway real**: sin `lab-preload.cjs`; variables de §2 solo en el proceso, nunca en archivos versionados.
3. Preflight de aislamiento (runner `scripts/catalog-transport-sandbox.cjs` sin `--execute`): identidad del bot (`getMe`), membresía del chat, descriptor vigente, escaneo de secretos.
4. Flujo manual mínimo con el navegador del propietario: importar un MP3 pequeño por «Add beat» (revisión y Save), reproducirlo, reemplazar MP3, añadir WAV, subir un PROJECT `.zip` y fusionar un `.flp`, cambiar portada, borrar y restaurar, descargar MP3/WAV/PROJECT y comprobar hash frente al original.
5. Casos de fallo: cortar la red durante la subida (el beat o PROJECT anterior debe quedar intacto), nombre duplicado, segunda importación simultánea.
6. Cierre: el runner limpia **solo** el ledger (`MessageEmpty` verificado); informe sin secretos; registrar resultados como evidencia **real** (sin mezclar con FAKE); **G2 permanece NOT_PROVEN hasta el dictamen de Sol**.

## 5. STOP aplicables
`STOP-APPROVAL` (sin autorización escrita), `STOP-GATE` (G2), `STOP-SECRET` (informe con secreto), `STOP-DATA` (cualquier borrado fuera del ledger), `STOP-ENV` (si el entorno no es el aislado).
