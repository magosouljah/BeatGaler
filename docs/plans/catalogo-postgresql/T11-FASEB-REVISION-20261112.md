# T11 fase B — Evidencia de aislamiento y runner real, para revisión de GPT-6 (2026-11-12)

**Estado:** runner implementado y probado **offline**; **no se ha ejecutado contra Telegram**. T11 NO PASS, G2 NOT_PROVEN. Autorización del propietario: Bot20 + vault de pruebas, solo durante esta sesión; ejecución condicionada a esta revisión. IDs abreviados.

## 1. Aislamiento verificado (lecturas, 2026-11-12, sin escrituras)

| Recurso | Evidencia | Resultado |
| --- | --- | --- |
| Bot20 `@AlessandroGaler20bot` (id `8824…598`) | Bot API `getMe` con el token del pool local = id/username del inventario; `getWebhookInfo`: sin webhook, 0 pendientes | identidad OK |
| Pool local `transport-bots.local.json` | contiene **solo** Bot20 (`managed:false`), creado por `stage-bot20.ps1` con verificación `getMe` | OK |
| MASTER `@yungplayground` (id `6328…800`) | segunda cuenta personal dedicada a pruebas (confirmación `SECOND-ACCOUNT` al crearla); `getMe` = username de `.env.telegram-test`; app de prueba propia (api_id `3294…503`, "TESTING BG") | OK |
| Vaults de prueba | DB local `beatgaler_gallery_test` (127.0.0.1:5432): 3 usuarios de prueba, 3 vaults, todos con Bot20 | OK |
| Chats de esos vaults | cada uno: **exactamente 2 miembros** (MASTER creador + Bot20 admin sin borrar/fijar), sin chat vinculado, 3/3/30 mensajes | aislados |
| Chat elegido para el run | `-100444…255` (usuario `testborrar`, 3 mensajes previos que el runner no toca) | — |

**Vínculos con producción encontrados:**
1. Bot20 es el nº 20 del **pool de 79 bots gestionados** de `GalerBotFactory` (gestor `@beatgalerbot`), que es el diseño de transporte de producción (`MANAGER_BOT_TOKEN_1`, `getManagedBotToken`). **No se puede comprobar localmente** si un Cloud productivo (AWS, fuera de alcance) arrienda Bot20 a algún vault. → **confirmación del propietario requerida** (§4).
2. MASTER es además una de las cuentas creadoras de la fábrica (sesiones antiguas "Galer" api_id `2512…267`, última actividad 2026-09-15) y propietaria de Bot20 en BotFather. El runner solo actúa sobre Bot20; esas sesiones no se tocan.

## 2. Runner (`scripts/catalog-transport-sandbox.cjs` + `…-real.cjs`)

- **Cercos previos a cualquier escritura:** descriptor `T11-SANDBOX` con TTL ≤ 24 h, `production:false` y sin credenciales; `BEATGALER_T11_SANDBOX_APPROVAL = approvalId`; `--execute`; identidad del bot (`getMe`) y de MASTER = descriptor; sin webhook; cada chat del descriptor = {MASTER creador, bot}. Cualquier discrepancia → `STOP-ISOLATION`.
- **Secretos:** solo en memoria; el informe se escanea (forma de token + secretos del proceso) y no se escribe si contiene alguno (`STOP-SECRET`).
- **Experimentos** (gateway T11 sin cambios):
  - **E6:** verificación del proveedor (tamaño, documento, remitente; id inexistente).
  - **E2:** respuesta perdida en bot y en MASTER → reconciliación por tres vías: Search de MASTER, Search del bot (se espera `BOT_METHOD_INVALID`; se mide) y sondeo de ids del bot con `channels.GetMessages`.
  - **E5:** mismo nombre con tamaño distinto, mismo tamaño y otra parte.
  - **E4:** mismo `random_id` reenviado con 0/5/65 s × misma sesión, reconexión con la misma auth key y auth key nueva (esta última solo bot); se cuentan las copias reales.
  - **E8:** sesión de bot antigua no revocada: editar/fijar/borrar lo propio y borrar lo de MASTER.
  - **E7:** rotación del token por BotFather (`/revoke` desde MASTER, propietaria): token viejo por Bot API, sesiones MTProto A/L ya abiertas, auth key A restaurada y sesión con el token nuevo.
- **Efectos reales previstos:**
  - ~40 mensajes de prueba (≤ 4 KB) en un solo chat;
  - 1 intento de fijado;
  - ~6 logins de bot;
  - 1 reconexión de MASTER;
  - 1 rotación del token de Bot20 (el nuevo se verifica con `getMe` y se persiste atómicamente en el pool local; el viejo deja de existir).
- **Limpieza:** MASTER borra **solo** los ids del ledger cuyo caption es `catalog:v1 op=t11b-<runId>-…`; se verifica `MessageEmpty`.
- **Pruebas offline:** `catalog-transport-sandbox.test.cjs` (5): cercos, aislamiento sin envíos, orquestación con dedup ausente/presente, rotación, limpieza solo del ledger y redacción. Suite `T11`: 15/15 PASS, red 0/0.

## 3. Límites conocidos (no se declaran resueltos)

- La respuesta perdida se **simula** descartando la respuesta en el cliente después del efecto real; no se induce una pérdida de red.
- FLOOD_WAIT no se induce (no se hace spam): E3 sigue ASSUMED.
- PROJECT por MASTER se prueba sobre el chat del vault (peer canal), no sobre un DM.
- Ventanas de dedup medidas solo a 0/5/65 s.
- La rotación por BotFather depende de su diálogo actual. Si BotFather no devuelve token, el runner para con `STOP-ROTATION`; el estado del token queda por verificar a mano.

## 4. Decisiones solicitadas

1. **Propietario:** confirmar que ningún Cloud/cliente de producción usa ni arrienda Bot20 (pool gestionado por `@beatgalerbot`). Sin esa confirmación, E7 (rotación) no se ejecuta; E2/E4/E5/E6/E8 solo escriben en el chat de prueba aislado.
2. **GPT-6:** aprobar el runner y el plan de efectos de §2, o pedir cambios, antes de `--execute`.

Comando previsto (WSL, credenciales leídas en proceso):

```
BEATGALER_T11_SANDBOX_APPROVAL=APR-20261112-T11B-PURP node scripts/catalog-transport-sandbox.cjs --descriptor tmp/t11b/descriptor.json --execute
```
