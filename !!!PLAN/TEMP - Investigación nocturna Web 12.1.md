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
- HEAD sigue siendo merge de PR #95 y no cambió en los turnos 00:58, 01:45, 02:42, 03:45, 04:43, 05:44 y 06:46.
- Open PR #93 sigue siendo el único PR abierto contra la rama; es un harness Windows F4/25.1 no relacionado con Web 12.1. No se encontró fix posterior ni trabajo duplicado relevante.
- TEMP acumulativo vive en `temp-web-12.1-night-research` porque canonical exige PR y esta investigación prohíbe abrir PR.

### Hechos confirmados

- Lockfile fija `@mtcute/web`, `@mtcute/core` y `@mtcute/wasm` 0.31.0; source upstream exacto: tag `v0.31.0`, commit `11b1c8894b653139b180c13620692f298bc147fb`.
- El 404 observado es un **MTProto transport error**, no HTTP.
- La secuencia productiva coincide con `SessionConnection.handleError()` de mtcute 0.31.0: primer 404 -> reconnect/reset Session; segundo 404 -> reset auth key + reauthorization.
- Web importa la temporary key como auth key primaria y no usa el lifecycle PFS nativo de mtcute.
- `_resetSession()` encola el sessionId viejo para `destroy_session`; PR #95 vuelve a imponer ese mismo ID como activo. Es un defecto concreto posterior al primer 404.
- `webTempAuth.ts` genera una temp key y hace `auth.bindTempAuthKey` manual usando `tempServerSalt`, `tempSessionId`, `msgId` y `seqNo` de la Session A.
- `auth.bindTempAuthKey` devuelve Bool.
- Upstream `_onRpcResult()` busca el `req_msg_id` en `session.pendingMessages`. Para un pending tipo `bind`, mtcute hace `_sendAck(messageId)`, resuelve la promise y elimina el pending. Si más tarde llega otra copia del mismo `rpc_result`, sólo se reconoce como duplicado si `recentOutgoingMsgIds` todavía contiene el req_msg_id; una Session B nueva no lo contiene.
- Por ello la mejor explicación de `unknown ...: true` sigue siendo replay del Bool de bind cuyo ACK/bookkeeping quedó en Session A. Confidence **94%**. Falta correlación numérica de `req_msg_id` en runtime para convertirlo en prueba.
- El bind manual usa `_authKeyTempSecondary` para descifrar la respuesta; la random sentinel en `_authKey` sólo satisface el guard de mtcute que exige una primary key ready antes de revisar los key IDs. El request de bind sale cifrado explícitamente con la temp key real.
- `SessionConnection.destroy()` no ejecuta `destroyAuthKey()`. `destroyAuthKey()` es una operación separada. `prepared.destroy()` no invalida intencionalmente la temporary auth key server-side.
- `prepared.destroy()` borra el buffer original de `authKeyBytes`, pero `bind()` devuelve `activeAuthKey.slice()`, por lo que el buffer exportado a Session B no se pone a cero por esa limpieza local.
- Session B usa la auth key importada en `_authKey`; `_authKeyTemp` queda vacío. El auth_key_id criptográfico depende de la key, no de la ranura local.
- `webTempAuth.ts` y Session B usan el mismo DC lógico y la misma tabla `productionDc(dcId)`/`primaryDcs`; el bind exitoso hace poco probable un perm/temp-key mismatch previo al handoff.
- Telegram exige `initConnection` después de cada `auth.bindTempAuthKey`.
- PR #94/PR #95 fuerzan `session.initConnectionCalled = true`, suprimiendo el `initConnection` real para no exponer API credentials y evitar `CONNECTION_API_ID_INVALID` con `apiId:0`.
- Los artefactos Task 5.1 inspeccionados (`probe-task-5.1-productive-temp-auth-compile.yml`, `regression-web-bound-temp-rpc.mjs`, `regression-task-5.1-hardening.mjs`) no prueban RPC server-side; son build/typecheck o asserts estáticos. El “historical live proof” citado por PR #94 sigue NO VERIFICADO.
- `next.connect()` con auth key ya importada y `disableUpdates:true` no necesita ejecutar autorización ni dispara una RPC de usuario en `onConnectionUsable()`; el primer método API explícito del worker es `next.getMe()`.
- En mtcute 0.31.0 `getMe()` es exactamente `users.getUsers({id:[inputUserSelf]})`.
- Como PR #95 marca `initConnectionCalled=true` antes de abrir la conexión y vuelve a aplicarlo en resets/pool, esa primera `users.getUsers` sale sin wrapper `initConnection`.
- El PFS nativo de mtcute después de bind exitoso conserva la misma `MtprotoSession`, mueve la temporary key secundaria a `_authKeyTemp`, instala `tempServerSalt` y pone `initConnectionCalled=false`. BeatGaler no ejecuta esa transición; exporta key y reconstruye otra Session.
- El bind manual de Session A usa `getSeqNo()` para una RPC content-related y avanza el contador. Session B es un `MtprotoSession` nuevo con `_seqNo=0`; PR #95 restaura el mismo `sessionId` pero no `_seqNo`.
- Telegram documenta `bad_msg_notification` code 32 para seqNo demasiado bajo cuando el mensaje fue decodificado. `msg_id`/time incorrectos tienen codes 16/17 y server salt incorrecto code 48.
- `new_session_created` existe precisamente para el caso en que el servidor tenga que crear/recrear estado de Session tras aceptar y descifrar un mensaje. Un session_id nuevo/desconocido no implica por sí solo transport 404.
- Telegram documenta que un `bad_msg_notification` sólo puede generarse si el servidor pudo decodificar correctamente el mensaje.
- Consecuencia nueva de 06:46: los campos de Session que sabemos que B pierde (`seqNo`, `lastMessageId`, salt/time, pending/recent/ACK state) son **defectos reales**, pero ninguno tiene ya una ruta documentada natural hacia un transport 404 si la key y el envelope llegan a decodificarse. Esto reduce la confidence de H1 como causa directa específica del primer 404, aunque H1 sigue 99% como defecto arquitectónico.
- Telegram define transport 404 como auth key no encontrada por el DC o error suficientemente temprano de MTProto/transport; también menciona errores de campos/framing de MTProto en normal operation.
- Telegram documenta que una temporary auth key puede ser olvidada server-side antes de `expires_at`, produciendo 404.
- Bajo PFS, cuando hay múltiples Sessions paralelas, cada Session genera y bindea su propia temp key; una temp key no debe tratarse como credential genérico libre de Session.
- `auth.bindTempAuthKey` define `temp_session_id` como el Session ID usado para invocar el bind.
- PR #95 acertó al preservar ese ID, pero montarlo sobre una `MtprotoSession` recién creada no reproduce el estado protocolario completo de A.
- Aun así, el nuevo acotamiento de 06:46 obliga a distinguir “arquitectura incorrecta” de “causa exacta del 404”: si el servidor logra localizar la temp key y descifrar B, los errores conocidos de continuidad deberían manifestarse como mensajes MTProto tipados, no como el 404 observado.
- WASM MIME sigue SECONDARY: fallback alcanza MAIN y procesa MTProto antes del 404.

### Hipótesis activas

#### H1 — handoff/reconstrucción incoherente de la Session bound

- confidence: **99% como defecto estructural**; **65% como causa o prerrequisito directo del primer 404**.
- descripción: bind ocurre en Session A y la primera RPC en Session B. PR #95 mantiene el `sessionId` correcto pero lo monta sobre estado nuevo, creando una continuación internamente contradictoria.
- evidencia a favor como defecto: Telegram define estado de Session y PFS por Session; upstream mantiene la misma `MtprotoSession`; BeatGaler reinicia `_seqNo`, `_lastMessageId`, pending/recent/ACK/salt/lifecycle y sólo restaura `_sessionId`.
- evidencia contra como explicación directa del 404: seqNo/msg_id/salt inválidos tienen `bad_msg_notification`/`bad_server_salt`; una Session server-side nueva puede producir `new_session_created`. Todas esas rutas presuponen que la key y el paquete fueron aceptados/descifrados.
- lectura actual: H1 probablemente debe corregirse, pero ya no puede presentarse como explicación suficiente del primer transport 404 sin un probe runtime.
- discriminante: A/B misma `MtprotoSession` vs handoff B, registrando además auth_key_id/DC y el primer envelope antes del error.

#### H2 — `initConnection` post-bind suprimido

- confidence: **100% como divergencia de protocolo**; **25% como causa directa del primer 404**; **alta probabilidad de blocker posterior**.
- a favor como defecto: requisito oficial y upstream pone `initConnectionCalled=false` tras bind PFS.
- en contra como primer 404: vive dentro del payload API después de que MTProto pudo aceptar/descifrar el mensaje; su fallo natural debería aparecer como RpcError, no como transport 404.
- discriminante: una vez establecida continuidad criptográfica/session válida, comparar initConnection real vs seam artificial.

#### H3 — temp auth_key_id no aceptado en B: key olvidada server-side, DC/routing o envelope/framing temprano

- confidence: **35% agregado como familia del primer 404**.
- a favor: es la familia que mejor coincide con la capa del transport 404 según documentación oficial.
- `temp key olvidada server-side`: documentada explícitamente como causa 404; no obstante la inmediatez/reproducibilidad hace poco convincente una expiración aleatoria.
- `DC/routing`: mismo dcId/primaryDcs reduce la probabilidad, pero falta un trace runtime que demuestre que A y B pegan al mismo endpoint/IP y que el key ID saliente de B es exactamente el del bind.
- `framing/envelope temprano`: mtcute normal genera el transporte de B, por lo que un bug genérico de framing es poco probable; todavía debe medirse el primer paquete para descartar interacción con reconnect/session seam.
- discriminante: log seguro de auth_key_id hash, DC + endpoint, delta bind->B, primer outbound TL/transport boundary y respuesta exacta.

#### H4 — recovery de PR #95 auto-destruye el sessionId restaurado

- confidence: **95% como defecto; ~70% segundo 404; 0% primer 404**.
- descripción: tras primer 404 mtcute encola old sessionId para destroy y PR #95 lo restaura como activo.

### Hipótesis / conclusiones descartadas o invalidadas

- `404 = HTTP 404` — DESCARTADA.
- `preservar únicamente tempSessionId basta` — INVALIDADA.
- `WASM MIME causa el 404` — DESCARTADA como root cause actual.
- `workflow Task 5.1 Productive Temp Auth Compile demuestra RPC productiva` — DESCARTADA.
- `regression-web-bound-temp-rpc.mjs demuestra aceptación server-side` — DESCARTADA.
- `Task 5.1 ya demuestra que suppress-initConnection funciona server-side` — NO VERIFICADA.
- `prepared.destroy()` destruye server-side la temporary auth key — DESCARTADA para la ruta normal de mtcute 0.31.0.
- `Session B puede estar cifrando accidentalmente con otra key local` — MUY IMPROBABLE.
- `una temporary auth key bound puede reutilizarse como auth key genérica en cualquier Session nueva del mismo DC` — INVALIDADA por documentación PFS.
- `si se conserva el mismo sessionId, una MtprotoSession recién creada equivale protocolariamente a continuar la Session anterior` — INVALIDADA.
- `la falta de initConnection es la candidata principal para el primer transport 404` — DEBILITADA.
- **NUEVO 06:46:** `seqNo/msg_id/salt/reset-state explican por sí solos el transport 404` — DEBILITADA/NO SOPORTADA. Si el servidor descifra el paquete, el protocolo define respuestas específicas distintas de 404.
- **NUEVO 06:46:** `un session_id nuevo/desconocido produce necesariamente 404` — DESCARTADA; Telegram define `new_session_created` para recreación de Session después de aceptar un mensaje.

### Primera secuencia productiva identificada

1. Session A abre socket y genera temp key.
2. A manda `auth.bindTempAuthKey` bajo `tempSessionId`; consume estado content-related.
3. A recibe `Bool true`; `_onRpcResult()` encola ACK, resuelve el bind y elimina el pending.
4. El ACK puede no haber sido flushado antes de destruir A.
5. Upstream correcto seguiría usando esa misma `MtprotoSession` A, promovería la temp key, instalaría temp salt y forzaría initConnection real.
6. BeatGaler devuelve una copia de la temp key, destruye A localmente y crea Session B desde cero.
7. B importa la temp key como `_authKey`.
8. El connect hook de PR #95 intercepta la conexión MAIN/DC correcta antes de `connect()` y restaura el `sessionId` de A; también fuerza `initConnectionCalled=true`.
9. B puede recibir replay del `Bool true`, pero no reconoce su `req_msg_id` porque pending/recent state quedó en A.
10. B mantiene `_seqNo=0`, `_lastMessageId` nuevo, ACK/pending/recent state vacío y lifecycle PFS perdido.
11. Primera RPC productiva explícita: `users.getUsers(inputUserSelf)`.
12. Producción reporta transport 404 antes de evidencia de RpcError de esa llamada.
13. Tras ese primer 404, PR #95 interactúa mal con `_resetSession()` y puede reactivar el mismo ID que mtcute acaba de encolar para `destroy_session`.

### Estado transferible entre conexiones — clasificación actualizada

| Estado | Clasificación | Nota |
|---|---|---|
| authKey bytes | REQUIRED | presente y usada por B |
| authKey slot `_authKey` vs `_authKeyTemp` | lifecycle REQUIRED | diseño actual rompe PFS recovery |
| tempSessionId | REQUIRED para continuar esa temp key/session | presente por PR95 |
| `_seqNo` | REQUIRED para continuidad correcta | B lo reinicia; error esperado si se decodifica: bad_msg |
| `_lastMessageId` / monotonic msg state | REQUIRED para continuidad correcta | B lo reinicia; error esperado si se decodifica: bad_msg |
| pending bind request / recent outgoing | debe resolverse o continuarse | perdido; explica unknown Bool |
| pending ACK del bind | debe flush/resolverse o continuarse | puede perderse |
| temp server salt | REQUIRED para transición limpia | upstream lo instala; error de salt si se decodifica es tipado |
| time offset | relevante | no transferido explícitamente; bad_msg si incorrecto |
| key temporal/PFS semantics | REQUIRED para expiry/recovery | hoy temp key se trata como primary |
| `initConnectionCalled` | debe quedar false post-bind hasta initConnection real | hoy se fuerza true |
| socket física | NOT REQUIRED | puede reemplazarse sin crear una nueva auth key |
| `MtprotoSession` lógica | **arquitectónicamente requerida para el flujo nativo** salvo serialización completa | upstream la conserva |
| nueva Session con misma temp key | **no es el modelo PFS recomendado** | nueva Session paralela debe bindear otra temp key |
| server-side key destruction al cerrar A | NOT EXPECTED | `destroy()` no llama `destroyAuthKey()` |
| auth_key_id/DC del primer outbound B | **MUST OBSERVE NEXT** | ahora es el dato de mayor valor para el 404 exacto |
| transport framing/endpoint B | **MUST OBSERVE NEXT** | 404 vive en esta capa o en key lookup temprano |

### Mejor explicación actual del `unknown rpc_result true`

Replay del `rpc_result` del `auth.bindTempAuthKey` exitoso cuyo ACK/pending bookkeeping quedó en Session A. Confidence **94%**. La lógica exacta de `_onRpcResult()` refuerza esta explicación: el bind pending es eliminado al resolver y una Session B nueva carece tanto del pending como del recent outgoing ID, por lo que una copia retransmitida se registra exactamente como `unknown message ...: true`.

### Mejor explicación actual del primer 404

Ya no es correcto atribuirlo específicamente a `seqNo`, `lastMessageId`, salt o un simple reset de Session: si el servidor localiza la auth key y descifra el paquete, Telegram tiene respuestas tipadas para esos errores y puede incluso crear/recrear estado de Session.

La capa del error obliga a concentrarse en **qué ocurre antes de esa decodificación útil**:

1. el auth_key_id temporal de B deja de existir/no se encuentra en el DC;
2. B llega a un DC/endpoint distinto del que conserva la temp key a pesar de usar el mismo dcId lógico;
3. el primer envelope/framing de B es rechazado lo bastante temprano para producir transport 404;
4. H1 sigue pudiendo ser un prerrequisito indirecto, pero hace falta observar la frontera exacta en runtime.

La reproducibilidad inmediata sigue haciendo improbable una expiración aleatoria simple. El A/B mismo Session A vs B sigue siendo útil, pero debe instrumentarse para observar key/DC/framing; de lo contrario sólo demostraría correlación arquitectónica y no la causa de capa.

### Próximo experimento de máximo valor

**Probe A/B de continuidad + frontera criptográfica/transport, una sola variable arquitectónica:**

- A: bind y primer método permitido/productivo en la **misma `MtprotoSession`** que hizo el bind, con transición PFS correcta y post-bind initConnection válido.
- B: flujo actual, nueva `MtprotoSession` + misma temp key + sessionId restaurado.

Registrar exclusivamente metadatos no secretos:

- hash del auth_key_id de A y B;
- dcId y hostname/endpoint WebSocket efectivo de A y B;
- bind req_msg_id;
- hash de sessionId;
- seqNo/lastMessageId;
- queued ACK count;
- primer TL outbound de B;
- presencia/ausencia de initConnection;
- tamaño de payload MTProto y framing length, sin bytes secretos;
- delta temporal bind Bool -> cierre A -> conexión B -> primer outbound;
- primera respuesta exacta: rpc_result/rpc_error/bad_msg/bad_server_salt/new_session_created/transport 404.

Discriminantes:

- A funciona y B 404, con mismo auth_key_id/DC/endpoint -> H1/handoff queda causalmente muy fuerte; inspeccionar diferencia de envelope/state antes de implementar.
- A funciona y B devuelve bad_msg en vez de 404 tras instrumentación -> el 404 productivo actual depende de una diferencia adicional de routing/key/framing no observada todavía.
- A también 404 inmediatamente tras bind -> subir H3 temp-key retention/bind/DC y bajar H1 como causa del primer 404.
- A funciona sólo con initConnection real -> H2 queda confirmado como blocker posterior pero no explica por sí solo la capa transport.
- B muestra auth_key_id/DC/endpoint distinto -> causa del primer 404 aislada fuera de los counters de Session.

No registrar auth keys completas, permanent credentials, nonces sensibles ni `encrypted_message`.

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

### Pregunta técnica única

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

### Pregunta técnica única

¿El “historical Task 5.1 live proof” usado por PR #94 realmente probó una RPC MTProto server-side equivalente al Web productivo?

### Resultado

- Workflow “Productive Temp Auth Compile” = build + typecheck, sin red.
- `regression-web-bound-temp-rpc.mjs` = asserts estáticos de source.
- hardening regression tampoco hace red.
- helper Desktop no es equivalente a Web PR95.
- live proof histórico queda NO VERIFICADO.

### Hipótesis al cierre

H1 82%; H2 72%; H3 18%.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 02:42

### Pregunta técnica única

¿Cuál es exactamente la primera RPC productiva que sale desde Session B y qué estado concreto de Session ya es incoherente antes de enviarla?

### Evidencia decisiva

1. `getMe()` es `users.getUsers(inputUserSelf)`.
2. `disableUpdates:true` evita `updates.getState` automático.
3. PR95 fuerza `initConnectionCalled=true`; `users.getUsers` sale sin initConnection.
4. El bind manual en A avanza `getSeqNo()` content-related.
5. B crea un `MtprotoSession` nuevo con `_seqNo=0`; PR95 sólo restaura `_sessionId`.
6. B reutiliza estado de secuencia incoherente dentro del mismo sessionId.
7. Telegram define bad_msg 32 para seqNo demasiado bajo.
8. Upstream PFS conserva la Session, activa temp key/salt y fuerza initConnection de nuevo.

### Impacto en hipótesis

- H1 94% defecto / 78% causa-prerrequisito primer 404.
- H2 100% divergencia / 62% causa directa.
- H3 8%.
- H4 sin cambio.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 03:45

### Pregunta técnica única

¿Qué cambio exacto entre Session A y B todavía puede explicar un transport 404, y puede descartarse que la key sea destruida o que B cifre con una key local distinta?

### Evidencia decisiva

1. `destroy()` no llama `destroyAuthKey()`.
2. B cifra con `_authKey` que contiene la temp key exportada.
3. El replay Bool descifrado apunta a continuidad criptográfica parcial, aunque todavía no está correlacionado numéricamente a B.
4. seqNo/msg_id/salt/initConnection tienen errores más específicos si la capa cifrada se acepta.
5. El primer 404 apunta más a aceptación temprana de key/envelope que a un RpcError normal.

### Impacto en hipótesis

- H1 96% defecto / 80% causa-prerrequisito primer 404.
- H2 100% divergencia / 58% causa directa.
- H3 ~4% mismatch/destrucción cliente; ~10% agregado.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 04:43

### Pregunta técnica única

¿La temporary auth key bound puede continuar en una `MtprotoSession` nueva, o el protocolo exige conservar la misma Session lógica que ejecutó `auth.bindTempAuthKey`?

### Evidencia decisiva

1. Telegram define cada Session por `(auth_key_id, session_id)` y estado propio.
2. Con PFS, una nueva Session concurrente debe generar y bindear otra temporary auth key.
3. `temp_session_id` es el Session ID usado para invocar el bind.
4. Upstream mtcute conserva la misma `MtprotoSession` después del bind.
5. BeatGaler destruye A, crea B y restaura sólo el ID.

### Resultado

H1 pasa a incompatibilidad concreta con el modelo PFS: la temp key es session-scoped y el handoff actual no conserva la Session lógica completa que la bindió.

### Impacto en hipótesis

- H1 99% defecto estructural / 87% causa-prerrequisito primer 404.
- H2 100% divergencia / 55% causa directa.
- H3 3% mismatch/destrucción cliente; 8% agregado.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 05:44

### Baseline / duplicate-check

Canonical siguió exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, tree `e8e2e19f430e42852fe963645c882f475e7792a6`. Sin fix posterior ni trabajo duplicado relevante para Web 12.1.

### Pregunta técnica única

¿La omisión de `initConnection` puede seguir siendo la explicación principal del primer transport 404, o la capa exacta del error obliga a priorizar temp-key/session/envelope?

### Evidencia decisiva

1. Telegram define transport 404 como auth key no encontrada por el DC o fallo temprano de MTProto/transport; ocurre por debajo de un RpcError normal.
2. Telegram documenta que una temp key puede desaparecer server-side antes de `expires_at` y eso produce precisamente 404.
3. `initConnection` es requisito post-bind, pero pertenece al payload API una vez que el mensaje MTProto fue aceptado/descifrado.
4. Por ello la falta de initConnection sigue siendo un defecto seguro, pero ya no es la explicación de capa más directa para el primer 404.
5. Mtcute reconoce esta semántica: con PFS activo un 404 dispara regeneración/rebind de temp key; BeatGaler ha perdido esa semántica al importar la temp key como primary con `usePfs:false`.

### Impacto en hipótesis

- H1: 99% defecto estructural / 90% causa-prerrequisito primer 404.
- H2: 100% divergencia / 35% causa directa primer 404.
- H3: 3% mismatch/destrucción cliente / 10% agregado incluyendo temp key olvidada.
- H4: sin cambio.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 06:46

### Baseline / duplicate-check

Canonical sigue exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, tree `e8e2e19f430e42852fe963645c882f475e7792a6`. El único PR abierto contra la rama sigue siendo #93 (harness Windows F4/25.1), no relacionado con Web 12.1. No hay fix posterior ni trabajo duplicado relevante.

### Pregunta técnica única

**¿Qué estado concreto perdido entre Session A y B puede producir específicamente el primer transport 404, en vez de un `bad_msg_notification`, `bad_server_salt`, `new_session_created` o RpcError?**

### Investigación realizada

Se contrastaron:

- documentación oficial de MTProto transports;
- detailed description / security checks de session_id, msg_id y seqno;
- service messages y `new_session_created`;
- comportamiento exacto de `_onRpcResult()` y `pendingMessages` de mtcute 0.31.0;
- `MtprotoSession.decryptMessage()`/`encryptMessage()` y selección de `_authKey`/`_authKeyTempSecondary`;
- `webTempAuth.ts` y el connect/session seam de `webTransport.worker.ts` actuales.

### Evidencia decisiva

1. Telegram dice que `bad_msg_notification` sólo existe cuando el servidor pudo **decodificar** el mensaje; seqNo bajo, msg_id/time y salt tienen errores tipados específicos.
2. Telegram define `new_session_created` cuando el servidor tiene que crear/recrear una Session después de aceptar un mensaje; por tanto “Session nueva/desconocida” tampoco explica automáticamente un 404.
3. El 404 transport permanece en una capa anterior: key lookup o rechazo temprano de MTProto/transport.
4. `_onRpcResult()` confirma más fuerte la explicación del `unknown true`: el bind pending se elimina al resolver; una retransmisión posterior en B, sin pending ni recent outgoing ID, genera exactamente el warning observado.
5. El bind manual cifra con la temp key real `_authKeyTempSecondary`; la random primary sentinel no sale como auth key del request.
6. B importa una copia de la misma key y el connect hook restaura el mismo sessionId antes de abrir la conexión MAIN/DC objetivo.
7. Por tanto los defectos ya demostrados de H1 siguen siendo obligatorios de corregir, pero **no hay todavía un campo concreto de Session perdido que explique documentalmente el 404 exacto**.
8. La investigación debe ahora observar auth_key_id/DC/endpoint/framing del primer outbound B; sin eso, subir H1 al 100% causal sería sobreafirmar.

### Impacto en hipótesis

- H1: **99% defecto estructural / 65% causa o prerrequisito directo del primer 404**. Baja la parte causal específica, no la certeza del defecto.
- H2: **100% divergencia / 25% causa directa primer 404**, sigue probable blocker posterior.
- H3: **35% agregado** para temp key no encontrada, routing/DC o envelope/framing temprano. Sube porque es la familia que coincide exactamente con la capa del error.
- H4: **95% defecto / ~70% segundo 404 / 0% primero**.
- unknown Bool = replay bind: **94%**.

### Conclusión invalidada/debilitada este turno

“Los counters/salt/session state reiniciados explican suficientemente el primer transport 404” — DEBILITADA. Explican que el handoff es inválido/incompleto, pero si el servidor descifra el mensaje deberían conducir primero a mensajes MTProto tipados. El primer 404 necesita un dato adicional aún no observado en la frontera auth_key_id/DC/framing.

### Próximo experimento

A/B misma Session A vs handoff B, pero instrumentando obligatoriamente la frontera temprana:

- auth_key_id hash A/B;
- DC + hostname efectivo A/B;
- primer TL outbound;
- payload/framing length sin contenido secreto;
- delta bind->B;
- primera respuesta exacta.

Esto distingue por primera vez entre “handoff arquitectónicamente malo” y “motivo exacto del transport 404”.

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

Hay dos defectos demostrados y un punto causal todavía sin cerrar:

1. **Handoff PFS/Session inválido:** BeatGaler hace el bind en Session A, destruye A y reconstruye B restaurando sólo parte del estado. Upstream mtcute conserva la misma `MtprotoSession`. Este defecto es 99% seguro.
2. **`initConnection` post-bind suprimido:** contradice documentación oficial y upstream. También es 100% seguro, pero por capa probablemente será un blocker posterior.
3. **Primer transport 404:** todavía falta demostrar qué condición exacta temprana hace que B no llegue ni siquiera a un error MTProto/RPC tipado.

El hallazgo más importante de 06:46 corrige un exceso de confianza previo: seqNo/msg_id/salt/session state incorrectos demuestran que el handoff es malo, pero Telegram define `bad_msg_notification`, `bad_server_salt` y `new_session_created` precisamente para mensajes que sí fueron aceptados/descifrados. Por tanto no deben usarse como explicación automática del 404.

### Confidence

- H1 handoff incoherente / temp key session-scoped: **99% defecto estructural / 65% causa-prerrequisito directo primer 404**.
- H2 initConnection suprimido: **100% divergencia / 25% causa directa primer 404; alta como blocker posterior**.
- H3 key no encontrada/DC/routing/framing temprano: **35% agregado**.
- H4 recovery self-destroy: **95% defecto / ~70% segundo 404**.
- unknown Bool = replay bind: **94%**.

### Evidencia nueva más importante de 06:46

- `bad_msg_notification` requiere que el servidor haya decodificado el mensaje.
- `new_session_created` demuestra que recrear estado de Session puede manejarse después de descifrar; no implica 404 automáticamente.
- `_onRpcResult()` exacto fortalece el vínculo del `unknown ...: true` con un replay del bind tras perder pending/recent state.
- El siguiente dato decisivo ya no es otro campo interno de Session aislado; es verificar **auth_key_id + DC/endpoint + framing del primer outbound B** frente a A.

### Fix

Aún NO autorizado. `READY_FOR_IMPLEMENTATION = NO`.

No se modificó producto, no se abrió PR, no hubo merge ni deploy.

### Próximo paso decisivo

Ejecutar un probe runtime A/B de una sola variable arquitectónica y capturar metadatos seguros en la frontera del primer mensaje:

- flujo A: bind + primera RPC en la misma `MtprotoSession`;
- flujo B: handoff actual;
- comparar key ID, DC/endpoint, framing length y respuesta exacta.

Sólo si A funciona y B falla con key/DC/endpoint equivalentes, el handoff queda suficientemente aislado para pasar hacia implementación. Si A también 404, la causa debe buscarse en binding/temp-key retention/DC antes de tocar la arquitectura de Session.

### Archivos probablemente involucrados cuando READY sea YES

- `src/features/cloud/webTempAuth.ts`
- `src/features/cloud/webTransportSession.ts`
- `src/features/cloud/webTransport.worker.ts`
- nueva regresión/probe runtime real de bound temp auth

### Validación futura mínima

bind -> continuidad PFS válida -> auth_key_id/DC correctos -> initConnection post-bind válido -> `getMe` correcto -> `getChat`/library browse, sin unknown bind replay, sin bad_msg, sin transport 404 y sin reconnect/reauthorize loop.

### No tocar todavía

WASM MIME, SSL/SNI y términos internos son secundarios. No eliminar TEMP hasta cerrar el bloqueo.

State: `CONTINUE_INVESTIGATION`