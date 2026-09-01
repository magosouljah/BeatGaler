# TEMP — Investigación nocturna Web 12.1

> Archivo temporal. Eliminar después de resolver el bloqueo.

## ESTADO ACUMULADO

### Síntoma principal actual

Producción posterior a PR #95 llega a Web MAIN real y reproduce, en este orden:

1. `received rpc_result for unknown message <id>: true`
2. `transport error 404. trying to reconnect`
3. `transport error 404, reauthorizing`
4. `Transport error: 404`
5. verify timeout ~35–36 s y reload/retry.

Task 12.1 sigue NO terminada.

### Baseline y duplicate-check

- Canonical `integration-v0.8.0-alpha.1` sigue en `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, tree `e8e2e19f430e42852fe963645c882f475e7792a6`.
- HEAD sigue siendo merge de PR #95 y no cambió durante toda la investigación nocturna hasta 08:44.
- El único PR abierto contra la rama sigue siendo #93 (`test(f4): rebuild packaged Windows auth evidence on live baseline`), ajeno a Web 12.1. No existe fix posterior ni trabajo duplicado relevante.
- TEMP acumulativo vive en `temp-web-12.1-night-research` porque canonical exige PR y esta investigación prohíbe abrir PR.

### Hechos confirmados

- Lockfile fija `@mtcute/web`, `@mtcute/core` y `@mtcute/wasm` 0.31.0; source upstream exacto: tag `v0.31.0`, commit `11b1c8894b653139b180c13620692f298bc147fb`.
- El 404 observado es un **MTProto transport error**, no HTTP.
- La secuencia productiva coincide con `SessionConnection.handleError()` de mtcute 0.31.0: primer 404 -> reconnect/reset Session; segundo 404 -> reset auth key + reauthorization.
- Web importa la temporary key como auth key primaria y no usa lifecycle PFS nativo.
- `_resetSession()` encola el sessionId viejo para `destroy_session`; PR #95 vuelve a imponer ese mismo ID como activo. Es un defecto concreto posterior al primer 404.
- `webTempAuth.ts` genera temp key y hace `auth.bindTempAuthKey` manual usando `tempServerSalt`, `tempSessionId`, `msgId` y estado de Session A.
- `auth.bindTempAuthKey` devuelve Bool.
- `_onRpcResult()` busca `req_msg_id` en `pendingMessages`. Para bind, mtcute encola ACK, resuelve promise y elimina pending. Una Session B nueva pierde pending y recent outgoing, por lo que una retransmisión se registra exactamente como `received rpc_result for unknown message ...: true`.
- Mejor explicación del `unknown ...: true`: replay del Bool de bind no ACKeado/continuado correctamente. Confidence **94%**; falta correlación numérica runtime del `req_msg_id`.
- `prepared.destroy()` no ejecuta `destroyAuthKey()` y no invalida intencionalmente la temp key server-side.
- B recibe una copia byte-a-byte de la misma temp key; el auth_key_id local se deriva determinísticamente de `SHA1(key)[-8]`, por lo que A/B tienen el mismo key ID.
- A y B usan el mismo `WebSocketTransport`, mismo `dc.id`, mismo hostname lógico WebSocket y mismo codec `Obfuscated(Intermediate)`.
- Telegram define Session como independiente de la conexión física; cambiar socket no debería por sí solo invalidar `(auth_key_id, session_id)`.
- Telegram exige `initConnection` después de cada `auth.bindTempAuthKey`.
- PR #94/#95 fuerzan `initConnectionCalled=true`, suprimiendo el `initConnection` real para evitar `CONNECTION_API_ID_INVALID` con `apiId:0`.
- Los artefactos Task 5.1 inspeccionados son build/typecheck o asserts estáticos; no prueban una RPC server-side equivalente al Web productivo. El “historical live proof” usado por PR #94 sigue NO VERIFICADO.
- `next.connect()` con `disableUpdates:true` no envía una RPC API de usuario; la primera RPC productiva explícita es `next.getMe()` -> `users.getUsers(inputUserSelf)`.
- El bind manual de A consume estado content-related; B crea una `MtprotoSession` nueva con `_seqNo=0`, `_lastMessageId` nuevo, pending/recent/ACK vacíos y sólo restaura `_sessionId`.
- Upstream PFS correcto conserva la misma `MtprotoSession`; después del bind mueve la key temporal a `_authKeyTemp`, instala `tempServerSalt`, pone `initConnectionCalled=false` y continúa sobre esa misma Session.
- Telegram define errores tipados para mensajes ya descifrados: seqNo bajo -> `bad_msg_notification` 32; msg_id/time -> 16/17; server salt incorrecto -> 48 / `bad_server_salt`; Session nueva aceptada -> `new_session_created`.
- Telegram define transport 404 principalmente como auth key no encontrada o fallo suficientemente temprano de MTProto/transport; una temp key puede ser olvidada antes de expiry.
- Con PFS, una Session concurrente nueva requiere una nueva temp key/bind; una temp key no debe tratarse como credential genérico reutilizable fuera de su Session lógica.
- `temp_session_id` es el Session ID usado para invocar el bind. PR #95 preserva ese ID, pero no el resto del estado protocolario.
- WASM MIME sigue SECONDARY: fallback alcanza MAIN y procesa MTProto antes del 404.

### Hallazgo 07:46 — key/DC/framing local casi descartados

1. A/B derivan necesariamente el mismo auth_key_id de los mismos 256 bytes.
2. `WebSocketTransport` deriva endpoint sólo de `dc.id`; `ipAddress` no crea una ruta lógica distinta.
3. A/B usan el mismo codec exacto.
4. Esto descarta prácticamente mismatch local de key ID, hostname/DC lógico y codec como causa del primer 404.

### Hallazgo nuevo 08:44 — el orden `unknown true -> 404` y el salt cero estrechan la causa

1. Telegram documenta que una respuesta RPC pendiente puede ser retransmitida después de cortar/reemplazar la conexión; romper la conexión no cancela la respuesta.
2. Telegram también documenta que una Session puede continuar sobre otra conexión física y que una respuesta nunca puede aparecer en una conexión de otra Session.
3. Producción recibe `unknown ...: true` **antes** del primer 404. Si —como indica la evidencia con 94% confidence— ese Bool es el replay de `auth.bindTempAuthKey`, B ya está recibiendo una respuesta pendiente de la Session A sobre la conexión nueva.
4. Esa observación vuelve mucho menos plausible que, antes del primer outbound productivo, el servidor haya simplemente olvidado la temp key o que la conexión B haya caído en un backend incapaz de resolverla: el servidor acaba de continuar estado de esa Session/key sobre B.
5. No es prueba matemática hasta correlacionar `req_msg_id`, pero cambia el peso relativo de hipótesis: **server-side early discard/backend missing-key baja fuertemente; envelope/estado B-específico sube**.
6. Hay además una omisión concreta nueva: `ServerSaltManager.currentSalt` nace en `Long.ZERO`. Upstream, tras bind PFS, ejecuta explícitamente `this._salts.currentSalt = tempServerSalt` antes de permitir tráfico normal.
7. BeatGaler no transfiere `tempServerSalt` a Session B. `importSession()` sólo recibe `primaryDcs`, `self` y `authKey`; el seam sólo restaura `_sessionId` e `initConnectionCalled`.
8. `ServerSaltManager.shouldFetchSalts()` devuelve false mientras `currentSalt` sea cero. Por tanto B no sólo arranca sin el salt de A: **tampoco dispara `get_future_salts` desde cero para repararlo antes de la primera RPC**.
9. `MtprotoSession.encryptMessage()` usa `this._salts.currentSalt`; por tanto la primera RPC de B sale con salt cero.
10. Salt cero/incorrecto es un defecto protocolario seguro, pero Telegram documenta `bad_server_salt`/code 48 cuando el mensaje ya fue descifrado. Por sí solo no explica bien el transport 404 observado.
11. Esto refuerza la conclusión general: la Session reconstruida B no es una continuación válida de A; faltan al menos seqNo/msg-id history/ACK bookkeeping/PFS slot/lifecycle/**server salt**/initConnection semantics.

### Hipótesis activas

#### H1 — handoff/reconstrucción incoherente de la Session bound

- confidence: **99% como defecto estructural; 88% como causa o prerrequisito directo del primer 404**.
- descripción: bind ocurre en A y la primera RPC en B; PR #95 preserva sólo `sessionId` sobre una Session nueva.
- a favor: upstream conserva la misma `MtprotoSession`; B pierde seqNo/msg IDs/pending/recent ACKs/salt/PFS semantics y fuerza initConnection a estado contrario al upstream.
- refuerzo 08:44: el replay `true` antes del 404 sugiere que key/session sí son visibles sobre B, reduciendo la alternativa “key simplemente olvidada”; además B envía con server salt cero.
- límite: salt/seqNo/msg_id incorrectos normalmente generan service errors tipados, por lo que todavía falta identificar qué propiedad exacta del primer envelope provoca 404.

#### H2 — `initConnection` post-bind suprimido

- confidence: **100% como divergencia; 20% como causa directa del primer 404; alta probabilidad de blocker posterior**.
- requisito oficial y upstream ponen `initConnectionCalled=false` tras bind.
- sigue siendo menos compatible con transport 404 que con RpcError/API-level failure.

#### H3 — rechazo temprano de temp key/backend/envelope

- confidence agregado: **12% como familia alternativa al H1 para el primer 404**.
- auth_key_id local distinto: ~1%, descartado prácticamente.
- DC/hostname lógico local distinto: ~1%, descartado prácticamente.
- codec local distinto: ~1%, descartado.
- temp key olvidada/backend efectivo sin key: **~5%** tras considerar que B recibe el replay `true` antes del 404.
- envelope B-específico temprano: ya se considera principalmente parte de H1, no una explicación independiente.

#### H4 — recovery PR #95 auto-destruye sessionId restaurado

- confidence: **95% defecto; ~70% segundo 404; 0% primer 404**.

### Hipótesis / conclusiones descartadas o invalidadas

- `404 = HTTP 404` — DESCARTADA.
- `preservar únicamente tempSessionId basta` — INVALIDADA.
- WASM MIME como root cause — DESCARTADA.
- workflows/regresiones Task 5.1 existentes como prueba live server-side — DESCARTADOS.
- `prepared.destroy()` destruye la temp key server-side — DESCARTADA para ruta normal.
- B cifra accidentalmente con otra key — DESCARTADA prácticamente.
- una temp key bound puede reutilizarse como auth genérica en una Session nueva — INVALIDADA por modelo PFS.
- mismo sessionId sobre una MtprotoSession nueva equivale a continuar la Session — INVALIDADA.
- falta de initConnection como candidata principal del primer 404 — DEBILITADA.
- seqNo/msg_id/salt por sí solos explican documentalmente el 404 — NO SOPORTADO; normalmente tienen service errors tipados.
- session_id nuevo/desconocido produce necesariamente 404 — DESCARTADA.
- A/B key ID distinto — DESCARTADA.
- A/B hostname/DC lógico distinto por `ipAddress` — DESCARTADA.
- A/B codec distinto — DESCARTADA.
- **NUEVO 08:44:** “Session B arranca con el mismo server salt válido de A” — DESCARTADA; B arranca con salt cero y no lo recupera automáticamente mientras siga en cero.
- **NUEVO 08:44:** “la explicación más probable es que el backend de B no conozca la temp key” — FUERTEMENTE DEBILITADA por el `unknown true` previo al 404, si se confirma numéricamente que es el bind replay.

### Primera secuencia productiva identificada

1. A genera temp key y abre Session.
2. A manda `auth.bindTempAuthKey` usando temp key, `tempServerSalt` y `tempSessionId`.
3. A recibe Bool true; mtcute encola ACK, resuelve bind y elimina pending.
4. ACK puede no flusharse antes de destruir A.
5. Upstream correcto promovería temp key en esa misma MtprotoSession, instalaría `tempServerSalt` y forzaría initConnection real.
6. BeatGaler copia key, destruye A localmente y crea B.
7. B importa la misma key como `_authKey`, restaura sólo sessionId y fuerza `initConnectionCalled=true`.
8. B arranca con `_seqNo=0`, msg-id history nueva, pending/recent/ACK vacío y **serverSalt=0**.
9. B puede recibir replay del Bool true y no reconocer su req_msg_id.
10. Primera RPC explícita: `users.getUsers(inputUserSelf)`; sale sin initConnection y cifrada con salt cero.
11. Producción reporta transport 404.
12. Recovery posterior de PR95 puede encolar destroy del mismo sessionId que vuelve a activar.

### Estado transferible entre conexiones — clasificación actual

| Estado | Clasificación | Nota |
|---|---|---|
| authKey bytes | REQUIRED | presente |
| auth_key_id | DERIVED / SAME | mismo necesariamente |
| tempSessionId | REQUIRED | presente por PR95 |
| `_seqNo` | REQUIRED para continuidad | perdido |
| `_lastMessageId` / msg-id history | REQUIRED | perdido |
| pending/recent bind bookkeeping | debe resolverse/continuarse | perdido; explica unknown Bool |
| ACK del bind | debe flush/continuarse | puede perderse |
| **tempServerSalt** | **REQUIRED** | **perdido; B usa 0** |
| time offset | relevante | no transferido explícitamente |
| PFS key slot/lifecycle | REQUIRED | perdido |
| initConnection post-bind | REQUIRED | hoy se suprime |
| socket física | NOT REQUIRED | reemplazable |
| MtprotoSession lógica | requerida para flujo nativo salvo serialización completa | upstream la conserva |
| backend/IP efectivo | observar sólo si hace falta | ahora menor prioridad |

### Próximo experimento de máximo valor

**Probe runtime de tres brazos, sin mezclar variables:**

- A1: bind + primera RPC en la misma `MtprotoSession` y misma socket.
- A2: bind + reconectar socket conservando la misma `MtprotoSession` lógica y primera RPC.
- B: flujo actual, nueva `MtprotoSession` + misma key + sessionId restaurado.

Registrar sólo metadatos no secretos:

- hash/auth_key_id, dcId/hostname;
- bind req_msg_id y hash de sessionId;
- seqNo/lastMessageId;
- current server salt como hash/zero-vs-nonzero, nunca secreto bruto si no hace falta;
- queued ACK count;
- primer TL outbound e initConnection sí/no;
- primera respuesta exacta.

Discriminantes:

- A1+A2 funcionan, B 404 -> reconstrucción de Session causal con confidence muy alta.
- A1 funciona, A2+B fallan -> reabrir cambio de socket/backend.
- A1 falla -> problema previo de bind/lifecycle; no implementar handoff todavía.
- Correlacionar `prepared.metadata.msgId` con el `req_msg_id` del `unknown true` convertiría el argumento key/session-visible-before-404 en evidencia directa.

### Issues secundarios

- P0: recovery PR95 self-destroy.
- P1: initConnection post-bind suprimido.
- P1: timeout/reload ~35 s puede generar retry storm/zombie worker.
- P2: WASM MIME `application/octet-stream` antes del fallback.
- P2: health-check SSL/SNI ocasional con SAN interno.
- P2: consola/browser expone términos internos Telegram/MTProto/mtcute.

`READY_FOR_IMPLEMENTATION = NO`

# CRONOLOGÍA DE INVESTIGACIÓN

## TURNO 2026-09-01 00:58

**Pregunta:** significado exacto del 404 y qué estado se pierde al pasar del bind manual al cliente productivo.

**Resultado:** 404 confirmado MTProto; unknown Bool explicado como probable bind replay; detectado self-destroy posterior a primer 404; detectada supresión de initConnection.

H1 78%; H2 60%; H3 20%; H4 95% defecto / ~70% segundo 404.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 01:45

**Pregunta:** si Task 5.1 realmente probó una RPC server-side equivalente.

**Resultado:** no; workflow y regresiones son build/typecheck/asserts estáticos. Live proof histórico queda NO VERIFICADO.

H1 82%; H2 72%; H3 18%.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 02:42

**Pregunta:** primera RPC de B y primer estado incoherente.

**Resultado:** `getMe()` -> `users.getUsers`; bind A avanza estado content-related; B nace con seqNo 0 y sólo restaura sessionId; upstream conserva Session.

H1 94% defecto / 78% causa-prerrequisito.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 03:45

**Pregunta:** si la key se destruye o B cifra con otra key.

**Resultado:** ambas explicaciones descartadas prácticamente; primer 404 apunta a aceptación temprana de key/envelope.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 04:43

**Pregunta:** si la temp key bound puede continuar en una MtprotoSession nueva.

**Resultado:** modelo PFS liga temp key a una Session; nueva concurrente requiere nueva temp key/bind; upstream conserva misma Session. Handoff actual es estructuralmente inválido.

H1 99% defecto / 87% causa-prerrequisito.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 05:44

**Pregunta:** si la omisión de initConnection explica mejor el transport 404.

**Resultado:** es defecto seguro pero de capa API; 404 encaja mejor con temp-key/session/envelope. H2 baja como causa directa.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 06:46

**Pregunta:** qué estado perdido puede producir 404 en vez de bad_msg/bad_salt/new_session/RpcError.

**Resultado:** campos conocidos tienen errores tipados; 404 queda en key lookup/rechazo temprano. H1 sigue obligatorio pero causa exacta no cerrada.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 07:46

**Pregunta:** si A/B usan key ID, DC/hostname o codec distintos.

**Resultado:** source exacto descarta las tres diferencias locales. Próximo probe se estrecha a A1 misma socket / A2 misma Session socket nueva / B Session reconstruida.

H1 99% defecto / 75% causa-prerrequisito; H3 25% residual.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 08:44

### Baseline / duplicate-check

Canonical sigue exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`; único PR abierto contra la rama: #93, F4/25.1 ajeno. No hay fix posterior ni duplicado Web 12.1.

### Pregunta técnica única

**¿El orden `unknown Bool true -> transport 404` permite distinguir “temp key olvidada/backend sin key” de “primer envelope de Session B inválido”, y qué estado upstream instala post-bind que B omite?**

### Investigación realizada

- Source exacto mtcute 0.31.0 de `_authorizePfs`, `_onRpcResult`, `_doFlush`, `MtprotoSession.encryptMessage()` y `ServerSaltManager`.
- Código canónico `webTransport.worker.ts`.
- Documentación oficial MTProto sobre Session independiente del socket, retransmisión de respuestas RPC pendientes, server salt y estado `(auth_key_id, session_id)`.

### Evidencia decisiva

1. `unknown true` aparece antes del 404.
2. Telegram puede retransmitir una respuesta pendiente tras reemplazar la conexión; no puede entregar una respuesta de una Session a otra Session.
3. Si ese Bool es el bind replay (94%), B ya está continuando estado server-side de esa misma Session/key justo antes del 404.
4. Esto baja fuertemente early key discard/backend-missing-key como explicación principal.
5. Upstream post-bind instala `tempServerSalt` en la misma Session.
6. B no lo importa: su `ServerSaltManager.currentSalt` queda `0`.
7. `shouldFetchSalts()` no solicita salts mientras currentSalt sea cero.
8. Primera RPC B se cifra usando salt cero.
9. Salt cero es defecto seguro pero normalmente debería provocar `bad_server_salt`, no transport 404; por tanto no cierra aún el campo causal exacto.

### Impacto en hipótesis

- H1: **99% defecto / 88% causa o prerrequisito directo primer 404**.
- H2: **100% divergencia / 20% causa directa primer 404**.
- H3 early discard/backend missing-key: **~5%**; familia alternativa agregada ~12%.
- H4: sin cambio.
- unknown Bool = bind replay: **94%**.

### Qué sí puede afirmarse

- La reconstrucción B es protocolariamente incompleta en más estado del que PR95 preserva, incluyendo ahora server salt demostrado.
- El simple cambio de socket/key visibility ya no es la explicación dominante.

### Qué NO puede afirmarse todavía

- Qué campo exacto del primer outbound transforma el fallo en transport 404.
- Que el `unknown true` es definitivamente el bind hasta correlacionar req_msg_id.

### Próximo experimento

A1/A2/B runtime y correlación del bind req_msg_id. Es el mínimo discriminante restante antes de autorizar implementación.

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

La investigación converge en un **handoff PFS/Session inválido**. BeatGaler hace bind en Session A y reconstruye B restaurando key + sessionId, pero pierde estado necesario que upstream conserva: seqNo/msg-id history, ACK/pending/recent state, PFS slot/lifecycle, **tempServerSalt**, y además fuerza initConnection al estado contrario del protocolo.

El hallazgo final de la noche estrecha el 404: `unknown ...: true` ocurre antes del 404. Si se confirma que es el bind replay —94% actual—, el servidor ya está continuando esa key/session sobre B, por lo que “key olvidada/backend sin key” deja de ser la explicación principal. El rechazo parece ligado al primer envelope/estado generado por la Session B reconstruida.

### Confidence final nocturna

- H1 handoff incoherente: **99% defecto estructural / 88% causa-prerrequisito primer 404**.
- H2 initConnection suprimido: **100% defecto / 20% causa directa primer 404; alta probabilidad de blocker posterior**.
- H3 early key discard/backend missing-key: **~5%**; alternativa agregada ~12%.
- H4 self-destroy recovery: **95% defecto / ~70% segundo 404**.
- unknown Bool = replay de bind: **94%**.

### Evidencia decisiva acumulada

- mismo auth_key_id, mismo DC/hostname lógico y mismo codec A/B;
- Session no depende de socket física;
- replay de respuesta RPC puede sobrevivir cambio de conexión;
- B pierde estado de Session aunque reutiliza el mismo sessionId;
- B arranca además con **serverSalt=0** y no lo auto-recupera antes de enviar;
- upstream conserva la misma MtprotoSession, instala temp salt y fuerza initConnection real;
- PR95 recovery tiene self-destroy hazard después del primer 404.

### Fix

Aún NO autorizado por la regla de investigación: `READY_FOR_IMPLEMENTATION = NO`.

No se modificó producto, no se abrió PR, no hubo merge ni deploy.

### Paso decisivo restante

Ejecutar probe runtime:

- A1: bind + primera RPC misma MtprotoSession/misma socket.
- A2: misma MtprotoSession con socket reconectada.
- B: handoff actual reconstruido.
- Correlacionar bind `msgId` con `unknown req_msg_id`.

Si A1+A2 funcionan y B falla, la reconstrucción queda causalmente demostrada y ya se puede diseñar el fix con riesgo bajo.

### Archivos probablemente involucrados cuando READY sea YES

- `src/features/cloud/webTempAuth.ts`
- `src/features/cloud/webTransportSession.ts`
- `src/features/cloud/webTransport.worker.ts`
- probe/regresión runtime real de bound temp auth

### Validación futura mínima

bind -> continuidad de Session/PFS válida -> temp salt válido -> initConnection post-bind válido -> `getMe` -> `getChat`/library browse, sin unknown bind replay, sin bad_msg/bad_salt, sin transport 404 y sin reconnect/reauthorize loop.

### No tocar todavía

WASM MIME, SSL/SNI y términos internos son secundarios. No eliminar TEMP hasta cerrar el bloqueo.

State: `CONTINUE_INVESTIGATION`