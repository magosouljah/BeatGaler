# TEMP — Investigación nocturna Web 12.1

> Archivo temporal. Eliminar después de resolver el bloqueo.

## ESTADO ACUMULADO

### Síntoma principal actual

Producción posterior a PR #95 llega a Web MAIN real y reproduce:

1. `received rpc_result for unknown message <id>: true`
2. `transport error 404. trying to reconnect`
3. `transport error 404, reauthorizing`
4. `Transport error: 404`
5. verify timeout ~35–36 s y reload/retry.

Task 12.1 sigue NO terminada.

### Baseline y duplicate-check

- Canonical: `integration-v0.8.0-alpha.1` @ `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`.
- Tree canónico: `e8e2e19f430e42852fe963645c882f475e7792a6`.
- HEAD sigue siendo merge de PR #95 y no cambió en los turnos 00:58, 01:45 y 02:42.
- No se encontró fix posterior de Task 12.1; no hay trabajo duplicado que deba evitarse.
- TEMP acumulativo vive en `temp-web-12.1-night-research` porque canonical exige PR y esta investigación prohíbe abrir PR.

### Hechos confirmados

- Lockfile fija `@mtcute/web`, `@mtcute/core` y `@mtcute/wasm` 0.31.0; source upstream exacto: tag `v0.31.0`, commit `11b1c8894b653139b180c13620692f298bc147fb`.
- El 404 observado es un **MTProto transport error**, no HTTP.
- La secuencia productiva coincide con `SessionConnection.handleError()` de mtcute 0.31.0: primer 404 -> reconnect/reset Session; segundo 404 -> reset auth key + reauthorization.
- Web importa la temporary key como auth key primaria y no usa el lifecycle PFS nativo de mtcute.
- `_resetSession()` encola el sessionId viejo para `destroy_session`; PR #95 vuelve a imponer ese mismo ID como activo. Es un defecto concreto posterior al primer 404.
- `webTempAuth.ts` genera una temp key y hace `auth.bindTempAuthKey` manual usando `tempServerSalt`, `tempSessionId`, `msgId` y `seqNo` de la Session A.
- `auth.bindTempAuthKey` devuelve Bool. La respuesta puede quedar sin ACK antes de destruir A; Session B no hereda pending/recent state. Mejor explicación de `unknown ...: true`: replay del Bool del bind. Confidence **92%**.
- El hecho de que Session B pueda descifrar ese `rpc_result true` es evidencia fuerte de continuidad parcial: el auth key ID importado y el sessionId restaurado son compatibles con ese tráfico entrante. Esto baja mucho la probabilidad de un simple “key/DC inexistente” como explicación del primer 404.
- Telegram exige `initConnection` después de cada `auth.bindTempAuthKey`.
- PR #94/PR #95 fuerzan `session.initConnectionCalled = true`, suprimiendo el `initConnection` real para no exponer API credentials y evitar `CONNECTION_API_ID_INVALID` con `apiId:0`.
- Los artefactos Task 5.1 inspeccionados (`probe-task-5.1-productive-temp-auth-compile.yml`, `regression-web-bound-temp-rpc.mjs`, `regression-task-5.1-hardening.mjs`) no prueban RPC server-side; son build/typecheck o asserts estáticos. El “historical live proof” citado por PR #94 sigue NO VERIFICADO.
- **NUEVO TURNO 02:42:** `next.connect()` con auth key ya importada y `disableUpdates:true` no necesita ejecutar autorización y no dispara una RPC de usuario en `onConnectionUsable()`; el primer método API explícito del worker es `next.getMe()`.
- **NUEVO TURNO 02:42:** en mtcute 0.31.0 `getMe()` es exactamente `users.getUsers({id:[inputUserSelf]})`.
- **NUEVO TURNO 02:42:** como PR #95 marca `initConnectionCalled=true` antes de abrir la conexión y vuelve a aplicarlo en resets/pool, esa primera `users.getUsers` sale sin wrapper `initConnection`.
- **NUEVO TURNO 02:42:** el PFS nativo de mtcute hace exactamente lo contrario después de un bind exitoso: intercambia la temporary key secundaria a la ranura temporal activa, copia `tempServerSalt` y pone `initConnectionCalled=false` para obligar a reescribir client info. BeatGaler no ejecuta esa transición nativa; exporta key y reconstruye otra Session.
- **NUEVO TURNO 02:42 — hallazgo principal:** el bind manual de Session A usa `connection._session.getSeqNo()` para una RPC content-related. En una Session recién creada eso devuelve el primer seqNo content-related y avanza el contador. Session B es un `MtprotoSession` nuevo: `_seqNo=0`. PR #95 restaura el **mismo sessionId** pero NO el contador `_seqNo`. Por tanto la primera RPC content-related en B (`users.getUsers`) vuelve a generar el primer seqNo content-related dentro del mismo sessionId. Esto es una inconsistencia MTProto concreta, no una hipótesis genérica de “faltan campos”.
- Telegram documenta que un `msg_seqno` demasiado bajo debería producir `bad_msg_notification` code 32 cuando el mensaje se decodifica correctamente. Por eso esta inconsistencia demuestra que el handoff es inválido, pero todavía no basta para afirmar que ella sola produce el transport 404 observado.
- De forma similar, time/msg_id incorrecto tiene códigos 16/17 y server salt incorrecto código 48. Eso reduce la probabilidad de que time offset o salt aislados expliquen directamente un 404 si el paquete llega a decodificarse.
- WASM MIME sigue SECONDARY: fallback alcanza MAIN y procesa MTProto antes del 404.

### Hipótesis activas

#### H1 — handoff/reconstrucción incoherente de la Session bound

- confidence: **94% como defecto estructural**; **78% como causa o prerrequisito directo del primer 404**.
- descripción: bind ocurre en Session A y la primera RPC en Session B. PR #95 conserva sessionId pero no conserva el estado monotónico de esa misma Session.
- evidencia decisiva nueva: A ya consumió un seqNo content-related durante `auth.bindTempAuthKey`; B vuelve a `_seqNo=0` y reutiliza el primer seqNo bajo el mismo sessionId.
- además se pierden pending ACK, pending request, recent outgoing IDs, last message state y salt/time state.
- en contra como explicación exacta de 404: Telegram especifica `bad_msg_notification 32` para seqNo demasiado bajo; falta ver qué paquete exacto dispara el 404 antes de concluir causalidad única.
- discriminante: preservar misma Session A para la primera RPC o transferir explícitamente estado monotónico y comparar.

#### H2 — `initConnection` post-bind suprimido

- confidence: **100% como divergencia de protocolo**; **62% como causa directa del primer 404**.
- descripción: primera RPC es `users.getUsers` sin el `initConnection` requerido tras bind.
- a favor: requisito oficial y upstream mtcute resetea `initConnectionCalled=false` después del bind PFS.
- en contra como causa exacta de 404: mtcute contiene manejo explícito de `CONNECTION_NOT_INITED`, lo que sugiere que una omisión de initConnection correctamente decodificada puede manifestarse como RPC error, no necesariamente transport 404.
- discriminante: misma Session/estado, comparar initConnection real vs seam artificial.

#### H3 — DC/key mismatch o temporary key desaparecida

- confidence: **8%**.
- a favor: 404 puede significar auth key not found y temp keys pueden desaparecer server-side.
- en contra: mismo DC en generación/bind/export; fallo determinista; Session B aparentemente descifra replay del Bool del bind usando la key importada y el sessionId restaurado.
- discriminante: correlacionar hashes de auth_key_id/DC en bind y primer paquete productivo.

#### H4 — recovery de PR #95 auto-destruye el sessionId restaurado

- confidence: **95% como defecto; ~70% segundo 404; 0% primer 404**.
- descripción: tras primer 404 mtcute encola old sessionId para destroy y PR #95 lo restaura como activo.

### Hipótesis / conclusiones descartadas o invalidadas

- `404 = HTTP 404` — DESCARTADA.
- `preservar únicamente tempSessionId basta` — INVALIDADA por producción y por seqNo reset confirmado.
- `WASM MIME causa el 404` — DESCARTADA como root cause actual.
- `workflow Task 5.1 Productive Temp Auth Compile demuestra RPC productiva` — DESCARTADA.
- `regression-web-bound-temp-rpc.mjs demuestra aceptación server-side` — DESCARTADA.
- `Task 5.1 ya demuestra que suppress-initConnection funciona server-side` — NO VERIFICADA; no usar como hecho.
- `salt/time/seqNo son intercambiables como causas genéricas de 404` — REFINADA: cada uno tiene errores MTProto específicos si el mensaje es decodificado; seqNo sigue siendo un defecto real de continuidad pero su relación exacta con 404 requiere traza.

### Primera secuencia productiva identificada

1. Session A abre socket y genera temp key.
2. Session A manda `auth.bindTempAuthKey` con temp auth key + bound `tempSessionId`; esta RPC consume seqNo content-related.
3. A recibe `Bool true`; ACK puede quedar pendiente.
4. A se destruye.
5. Session B se crea desde cero, importa temp key como primary y PR #95 restaura sólo el sessionId.
6. B puede recibir replay del `Bool true`, pero no reconoce su `req_msg_id`.
7. B mantiene `_seqNo=0` y `initConnectionCalled=true` artificial.
8. Primera RPC de producto: `users.getUsers(inputUserSelf)`; vuelve a usar el primer seqNo content-related y sale sin `initConnection`.
9. Producción reporta después transport 404.

### Estado transferible entre conexiones — clasificación actualizada

| Estado | Clasificación | Nota |
|---|---|---|
| authKey bytes | REQUIRED | presente |
| tempSessionId | REQUIRED | presente por PR95 |
| `_seqNo` | **REQUIRED si se conserva el mismo sessionId** | defecto concreto: B lo reinicia |
| `_lastMessageId` / monotonic msg state | REQUIRED o debe iniciarse una Session nueva coherente | B lo reinicia |
| pending bind request / recent outgoing | no necesariamente transferible, pero debe resolverse antes del handoff | hoy se pierde; explica unknown Bool |
| pending ACK del bind | debe flush/resolverse o continuarse coherentemente | hoy puede perderse |
| temp server salt | REQUIRED para transición limpia; puede recuperarse por bad_server_salt | no transferido explícitamente |
| time offset | relevante; tiene recovery propio | no transferido explícitamente |
| key temporal/PFS semantics | REQUIRED para lifecycle/recovery correcto | hoy temp key se importa como primary |
| `initConnectionCalled` | debe quedar false post-bind hasta initConnection real | hoy se fuerza true |
| socket física | NOT REQUIRED | puede reemplazarse |

### Mejor explicación actual del `unknown rpc_result true`

Replay del `rpc_result` del `auth.bindTempAuthKey` exitoso cuyo ACK/pending bookkeeping quedó en Session A. Confidence **92%**. Aún falta correlación numérica de `req_msg_id`, pero el tipo Bool, el orden y el handoff encajan.

### Mejor explicación actual del primer 404

El handoff actual no continúa una Session MTProto válida: conserva la identidad de Session pero reinicia estado monotónico y además omite la reinicialización API exigida. La nueva evidencia hace a H1 estructuralmente casi segura. Lo que NO está aislado todavía es cuál de esas divergencias hace que el servidor elija transport 404 en lugar de un `bad_msg_notification`/RPC error.

Lectura más precisa:

1. `users.getUsers` es la primera RPC de producto confirmada.
2. Sale con sessionId antiguo + seqNo reiniciado + sin initConnection.
3. Esos tres hechos ya bastan para decir que PR #95 no reconstruye una Session protocolariamente equivalente.
4. No implementar todavía hasta identificar cuál cambio mínimo evita el primer 404 sin introducir credenciales permanentes en browser.

### Próximo experimento de máximo valor

**Aislar Session continuity antes que seguir buscando síntomas secundarios.** Probe de un solo eje:

- Caso A: después de `bind=true`, ejecutar la primera RPC usando la MISMA `MtprotoSession`/SessionConnection A, con ACK resuelto y el estado seqNo/messageId/salt original.
- Caso B: handoff actual a B restaurando sólo sessionId.
- Log seguro: hash auth_key_id, hash sessionId, bind req_msg_id, `_seqNo` antes/después del bind y justo antes de primera RPC, tipo del primer objeto, si initConnection está realmente envuelto, respuesta/error exacto.

Interpretación:
- A funciona / B falla -> H1 aislada.
- A falla sin initConnection pero funciona con initConnection real -> H2 aislada.
- Si B devuelve bad_msg 32 antes de cualquier 404 -> seqNo confirmado como primer fallo.
- Si el primer paquete de B produce 404 aun con seqNo/salt coherentes -> revisar key semantics/framing/DC.

No registrar auth keys, nonces permanentes ni credenciales.

### Issues secundarios

- P0: recovery PR #95 puede destruir el mismo sessionId restaurado.
- P1: initConnection post-bind está suprimido contra protocolo.
- P1: timeout/reload ~35 s puede generar retry storm/zombie worker.
- P2: WASM servido como `application/octet-stream` antes del fallback.
- P2: health-check SSL/SNI ocasionalmente observa SAN interno.
- P2: consola/browser expone términos internos Telegram/MTProto/mtcute.

`READY_FOR_IMPLEMENTATION = NO`

# CRONOLOGÍA DE INVESTIGACIÓN

## TURNO 2026-09-01 00:58

### Baseline

`integration-v0.8.0-alpha.1 @ 43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, merge PR #95. CI verde; producción falla.

### Pregunta principal

¿Qué significa exactamente el 404 en mtcute 0.31.0 y qué estado se pierde al pasar del bind manual al TelegramClient productivo?

### Resultado

- 404 confirmado como MTProto transport error.
- `unknown ...: true` explicado con alta confidence como replay del Bool de bind no ACKeado antes de destruir A.
- PR #95 crea self-destroy hazard tras primer 404.
- Web suprime initConnection exigido post-bind.

### Hipótesis al cierre

H1 78%; H2 60%; H3 20%; H4 95% defecto / ~70% segundo 404.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 01:45

### Baseline / duplicate-check

Canonical sin cambios en `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`; sin fix posterior.

### Pregunta técnica única

¿El “historical Task 5.1 live proof” usado por PR #94 realmente probó una RPC MTProto server-side equivalente al Web productivo?

### Resultado

- Workflow “Productive Temp Auth Compile” = build + typecheck, sin red.
- `regression-web-bound-temp-rpc.mjs` = asserts estáticos de source; exige incluso el seam `initConnectionCalled=true`.
- hardening regression tampoco hace red.
- helper Desktop es runtime pero no equivalente a Web PR95.
- live proof histórico queda NO VERIFICADO.
- H1 82%; H2 72%; H3 18%.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 02:42

### Baseline / duplicate-check

Canonical sigue exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`; tree `e8e2e19f430e42852fe963645c882f475e7792a6`. No cambió GitHub respecto al turno anterior y no apareció fix duplicado.

### Pregunta técnica única

**¿Cuál es exactamente la primera RPC productiva que sale desde Session B y qué estado concreto de Session ya es incoherente antes de enviarla?**

### Investigación realizada

Se inspeccionó:

- `src/features/cloud/webTransport.worker.ts` canónico;
- `src/features/cloud/webTempAuth.ts` canónico;
- mtcute v0.31.0 `highlevel/methods/users/get-me.ts`;
- mtcute v0.31.0 `session-connection.ts`;
- mtcute v0.31.0 `mtproto-session.ts`;
- documentación oficial MTProto de seqNo, bad_msg_notification, PFS e initConnection.

### Evidencia decisiva

1. `getMe()` es `users.getUsers(inputUserSelf)`.
2. `disableUpdates:true` evita el `updates.getState` automático del main connection; por tanto no hay una RPC de usuario anterior generada por `onConnectionUsable()`.
3. PR95 fuerza `initConnectionCalled=true`; `users.getUsers` sale sin initConnection.
4. El bind manual en A llama `getSeqNo()` para una RPC content-related y avanza el contador.
5. B crea un `MtprotoSession` nuevo con `_seqNo=0`; PR95 sólo restaura `_sessionId`.
6. En consecuencia B conserva el mismo sessionId pero reutiliza un seqNo content-related ya consumido en A.
7. Telegram define seqNo monotónico dentro de una Session y code 32 para seqNo demasiado bajo. Esto demuestra una ruptura real de continuidad aunque todavía no prueba que sea el origen exacto del transport 404.
8. Upstream mtcute, después de bind PFS, conserva la Session, activa la temp key/salt y pone `initConnectionCalled=false`; Web productivo no reproduce esa transición.

### Impacto en hipótesis

- H1 sube a **94% como defecto estructural** y **78% como causa/prerrequisito del primer 404**.
- H2 queda **100% divergencia**, pero baja a **62% como causa directa de 404** porque el stack contempla `CONNECTION_NOT_INITED` como error RPC posible si el mensaje llega decodificado.
- H3 baja a **8%**: el replay Bool descifrado en B hace menos probable una key/DC simplemente inexistente.
- H4 sin cambio.

### Qué puede afirmarse ahora

PR #95 no puede representar una continuación válida de la misma Session sólo preservando `sessionId`: el contador secuencial de esa Session ya diverge antes de la primera RPC productiva.

### Qué NO puede afirmarse todavía

No está demostrado si el primer servidor-reject real es seqNo 32, falta de initConnection, otro campo de Session o framing/key semantics que derive en 404. Sin traza del primer paquete/respuesta no elegir un fix de producto.

### Siguiente pregunta

¿Al ejecutar la primera RPC sobre la MISMA Session A desaparece el 404, y cuál es el primer error exacto cuando se compara contra el handoff B?

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

El problema ya no debe describirse sólo como “handoff incompleto”. Hay una inconsistencia específica: el bind se hace en Session A y consume estado monotónico; Session B reutiliza el mismo sessionId pero reinicia seqNo/message bookkeeping y además omite el initConnection post-bind. PR #95 arregló identidad de Session sin restaurar continuidad de Session.

### Confidence

- H1 handoff incoherente: **94% defecto estructural / 78% causa-prerrequisito del primer 404**.
- H2 initConnection suprimido: **100% divergencia / 62% causa directa**.
- H3 key/DC mismatch: **8%**.
- H4 recovery self-destroy: **95% defecto / ~70% segundo 404**.
- unknown Bool = replay bind: **92%**.

### Evidencia nueva más importante de 02:42

La primera RPC productiva está identificada: `users.getUsers(inputUserSelf)`. Sale bajo el sessionId del bind, pero desde un `MtprotoSession` nuevo cuyo seqNo volvió a cero. El bind ya había consumido el primer seqNo content-related. Esto prueba que preservar sólo `tempSessionId` no preserva la Session.

### Fix

Aún NO autorizado ni suficientemente aislado. No se modificó producto, no se abrió PR, no hubo merge ni deploy.

### Archivos probablemente involucrados cuando READY sea YES

- `src/features/cloud/webTempAuth.ts`
- `src/features/cloud/webTransportSession.ts`
- `src/features/cloud/webTransport.worker.ts`
- nueva regresión/probe runtime real de bound temp auth

### Validación futura mínima

bind -> primera RPC real -> `getMe` correcto -> `getChat`/library browse, sin unknown bind replay, sin bad_msg, sin transport 404 y sin reconnect/reauthorize loop.

### No tocar todavía

WASM MIME, SSL/SNI y términos internos son secundarios. No eliminar TEMP hasta cerrar el bloqueo.

State: `CONTINUE_INVESTIGATION`