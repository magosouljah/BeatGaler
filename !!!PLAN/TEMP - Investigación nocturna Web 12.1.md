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
- HEAD sigue siendo merge de PR #95 y no cambió en los turnos 00:58, 01:45, 02:42, 03:45, 04:43, 05:44, 06:46 y 07:46.
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
- Telegram define transport 404 como auth key no encontrada por el DC o error suficientemente temprano de MTProto/transport; también menciona errores de campos/framing de MTProto en normal operation.
- Telegram documenta que una temporary auth key puede ser olvidada server-side antes de `expires_at`, produciendo 404.
- Bajo PFS, cuando hay múltiples Sessions paralelas, cada Session genera y bindea su propia temp key; una temp key no debe tratarse como credential genérico libre de Session.
- `auth.bindTempAuthKey` define `temp_session_id` como el Session ID usado para invocar el bind.
- PR #95 acertó al preservar ese ID, pero montarlo sobre una `MtprotoSession` recién creada no reproduce el estado protocolario completo de A.
- Telegram confirma que la Session pertenece a la aplicación y **no** a una conexión WebSocket/TCP concreta: una conexión física puede reemplazarse manteniendo `(auth_key_id, session_id)`. Por tanto, cerrar A y abrir B no debería por sí solo invalidar la Session o la key.
- WASM MIME sigue SECONDARY: fallback alcanza MAIN y procesa MTProto antes del 404.

### Hallazgo nuevo 07:46 — la frontera local key/DC/framing queda casi cerrada por source

1. En mtcute 0.31.0 `AuthKey.setup(authKey)` calcula siempre `id = SHA1(authKey).subarray(-8)`. Como B recibe `activeAuthKey.slice()` de los mismos 256 bytes usados por A, **A y B necesariamente producen el mismo auth_key_id local**. No existe una segunda fuente de key ID ni depende del slot `_authKey`/`_authKeyTemp`.
2. `WebSocketTransport.connect(dc)` de mtcute Web 0.31.0 **ignora `dc.ipAddress`** y construye el URL únicamente como `wss://<subdomain por dc.id>.web.telegram.org/apiws`.
3. `webTempAuth.ts` usa `new WebSocketTransport()` para A y `TelegramClient` Web usa por defecto el mismo `new WebSocketTransport()` para B.
4. `temp_primary_dcs.main.id` exportado por A es exactamente el mismo `dcId`, y el seam de B sólo actúa si `connection.params.dc.id === primaryDcId`.
5. Por source, A y B usan el **mismo hostname lógico WebSocket** para el mismo `dcId`; una discrepancia por `ipAddress` configurado queda descartada.
6. Ambos usan el mismo `WebSocketTransport.packetCodec()`: `ObfuscatedPacketCodec(new IntermediatePacketCodec())`. Un bug genérico de codec/framing cliente que afectara sólo a B queda mucho menos probable; la diferencia debe estar por encima del codec o en comportamiento dinámico de red/backend.
7. Consecuencia: la familia H3 se divide. **Mismatch local de auth_key_id = prácticamente descartado; mismatch local de hostname/DC lógico = prácticamente descartado; codec/framing genérico = muy debilitado.** Lo que queda de H3 es (a) temp key olvidada server-side antes del primer mensaje de B, (b) distinto backend efectivo detrás del mismo hostname con falta de visibilidad de la temp key, o (c) algún envelope B-específico que Telegram traduzca a 404 antes de devolver un service message tipado.
8. La documentación oficial dice que la Session no está atada al socket y que una conexión puede cambiar. Eso hace que una invalidación determinista sólo por cerrar A sea incompatible con el modelo esperado, aunque el servidor sí puede olvidar una temp key antes de `expires_at`.
9. A falta de runtime, el dato externo que aún no puede probarse por source es si dos WebSockets sucesivos al mismo hostname aterrizan en backends distintos y si la temporary key está visible en ambos. Ese dato requiere probe/log de conexión efectiva o mantener la misma `MtprotoSession`/socket como A/B.

### Hipótesis activas

#### H1 — handoff/reconstrucción incoherente de la Session bound

- confidence: **99% como defecto estructural; 75% como causa o prerrequisito directo del primer 404**.
- descripción: bind ocurre en Session A y la primera RPC en Session B. PR #95 mantiene el `sessionId` correcto pero lo monta sobre estado nuevo, creando una continuación internamente contradictoria.
- evidencia a favor como defecto: Telegram define estado de Session y PFS por Session; upstream mantiene la misma `MtprotoSession`; BeatGaler reinicia `_seqNo`, `_lastMessageId`, pending/recent/ACK/salt/lifecycle y sólo restaura `_sessionId`.
- evidencia a favor renovada como causa: 07:46 descarta por source los dos candidatos locales alternativos más simples de H3 —auth_key_id distinto y hostname/DC lógico distinto— y debilita codec genérico.
- evidencia contra como explicación directa: seqNo/msg_id/salt inválidos tienen service errors tipados si la key y el mensaje son aceptados/descifrados.
- discriminante: A/B misma `MtprotoSession` vs handoff B, conservando mismo key/DC y registrando primera respuesta.

#### H2 — `initConnection` post-bind suprimido

- confidence: **100% como divergencia de protocolo; 25% como causa directa del primer 404; alta probabilidad de blocker posterior**.
- a favor como defecto: requisito oficial y upstream pone `initConnectionCalled=false` tras bind PFS.
- en contra como primer 404: vive dentro del payload API después de que MTProto pudo aceptar/descifrar el mensaje; su fallo natural debería aparecer como RpcError, no como transport 404.
- discriminante: una vez establecida continuidad criptográfica/session válida, comparar initConnection real vs seam artificial.

#### H3 — rechazo temprano de temp key/envelope en B

- confidence: **25% agregado como causa directa del primer 404**, pero ya no por mismatch local simple.
- `auth_key_id local distinto`: **~1%, prácticamente descartado por derivación determinista de la misma key**.
- `DC/hostname lógico local distinto`: **~1%, prácticamente descartado por WebSocketTransport + mismo dcId**.
- `codec/framing genérico distinto`: **~5%, muy debilitado porque A y B usan el mismo codec exacto**.
- `temp key olvidada server-side / backend efectivo distinto`: **20%**, documentalmente compatible con 404 pero aún sin evidencia runtime y difícil de reconciliar con fallo inmediato determinista + modelo de Session independiente del socket.
- `envelope B-específico rechazado como transport 404`: **20%**, familia residual; requiere observar el primer mensaje real o A/B.

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
- `Session B puede estar cifrando accidentalmente con otra key local` — DESCARTADA prácticamente.
- `una temporary auth key bound puede reutilizarse como auth key genérica en cualquier Session nueva del mismo DC` — INVALIDADA por documentación PFS.
- `si se conserva el mismo sessionId, una MtprotoSession recién creada equivale protocolariamente a continuar la Session anterior` — INVALIDADA.
- `la falta de initConnection es la candidata principal para el primer transport 404` — DEBILITADA.
- `seqNo/msg_id/salt/reset-state explican por sí solos el transport 404` — DEBILITADA/NO SOPORTADA.
- `un session_id nuevo/desconocido produce necesariamente 404` — DESCARTADA.
- **NUEVO 07:46:** `A y B pueden estar calculando auth_key_id distintos a partir de la misma temp key` — DESCARTADA por source exacto de `AuthKey.setup()`.
- **NUEVO 07:46:** `A y B pueden estar yendo a hostnames WebSocket diferentes porque uno usa ipAddress y el otro primaryDcs` — DESCARTADA por source exacto: WebSocketTransport ignora `ipAddress` y deriva hostname exclusivamente de `dc.id`.
- **NUEVO 07:46:** `A y B usan codecs de transporte distintos` — DESCARTADA; ambos usan el mismo `WebSocketTransport` y `Obfuscated(Intermediate)`.

### Primera secuencia productiva identificada

1. Session A abre socket y genera temp key.
2. A manda `auth.bindTempAuthKey` bajo `tempSessionId`; consume estado content-related.
3. A recibe `Bool true`; `_onRpcResult()` encola ACK, resuelve el bind y elimina el pending.
4. El ACK puede no haber sido flushado antes de destruir A.
5. Upstream correcto seguiría usando esa misma `MtprotoSession` A, promovería la temp key, instalaría temp salt y forzaría initConnection real.
6. BeatGaler devuelve una copia de la temp key, destruye A localmente y crea Session B desde cero.
7. B importa la temp key como `_authKey`; por source calcula el mismo auth_key_id que A.
8. El connect hook de PR #95 intercepta la conexión MAIN del mismo `dcId` antes de `connect()`, restaura el `sessionId` de A y fuerza `initConnectionCalled=true`.
9. A y B usan el mismo hostname lógico `wss://<dc-subdomain>.web.telegram.org/apiws` y el mismo codec de transporte.
10. B puede recibir replay del `Bool true`, pero no reconoce su `req_msg_id` porque pending/recent state quedó en A.
11. B mantiene `_seqNo=0`, `_lastMessageId` nuevo, ACK/pending/recent state vacío y lifecycle PFS perdido.
12. Primera RPC productiva explícita: `users.getUsers(inputUserSelf)`.
13. Producción reporta transport 404 antes de evidencia de RpcError de esa llamada.
14. Tras ese primer 404, PR #95 interactúa mal con `_resetSession()` y puede reactivar el mismo ID que mtcute acaba de encolar para `destroy_session`.

### Estado transferible entre conexiones — clasificación actualizada

| Estado | Clasificación | Nota |
|---|---|---|
| authKey bytes | REQUIRED | presente y usada por B |
| auth_key_id | DERIVED / SAME | SHA1(key)[-8], mismo necesariamente en A/B |
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
| socket física | NOT REQUIRED | protocolo permite reemplazar conexión |
| `MtprotoSession` lógica | **arquitectónicamente requerida para el flujo nativo** salvo serialización completa | upstream la conserva |
| nueva Session con misma temp key | **no es el modelo PFS recomendado** | nueva Session paralela debe bindear otra temp key |
| server-side key destruction al cerrar A | NOT EXPECTED | `destroy()` no llama `destroyAuthKey()` y Session no depende del socket |
| hostname lógico A/B | SAME por source | WebSocketTransport deriva ambos de `dc.id` |
| codec A/B | SAME por source | Obfuscated(Intermediate) |
| backend/IP efectivo | **MUST OBSERVE** | mismo hostname no prueba mismo nodo backend |

### Mejor explicación actual del `unknown rpc_result true`

Replay del `rpc_result` del `auth.bindTempAuthKey` exitoso cuyo ACK/pending bookkeeping quedó en Session A. Confidence **94%**. La lógica exacta de `_onRpcResult()` refuerza esta explicación: el bind pending es eliminado al resolver y una Session B nueva carece tanto del pending como del recent outgoing ID, por lo que una copia retransmitida se registra exactamente como `unknown message ...: true`.

### Mejor explicación actual del primer 404

La investigación 07:46 elimina tres explicaciones locales simples: auth_key_id distinto, hostname/DC lógico distinto y codec de transporte distinto. A y B comparten los mismos 256 bytes de key, el key ID se deriva determinísticamente de esos bytes, el WebSocket URL se deriva del mismo `dc.id` y ambos usan el mismo codec.

Eso deja dos familias plausibles:

1. **El handoff Session/PFS de BeatGaler altera algún aspecto B-específico del primer envelope/estado que Telegram rechaza tempranamente**, aunque los campos conocidos seqNo/salt/msg_id normalmente tienen service errors tipados. H1 vuelve a subir como candidato por eliminación de alternativas, no porque exista todavía un campo único demostrado.
2. **La temp key deja de estar visible server-side entre A y B** (early discard o backend efectivo distinto detrás del mismo hostname). Telegram documenta que una temp key puede olvidarse antes de expiry, pero el modelo oficial también dice que una Session no está atada al socket, así que un fallo inmediato y determinista al cambiar conexión sería anómalo y requiere prueba runtime.

No hay base suficiente para afirmar cuál de estas dos ocurre sin el A/B runtime.

### Próximo experimento de máximo valor

**Probe A/B de continuidad, ahora mucho más estrecho:**

- A: bind y primera RPC en la **misma `MtprotoSession`** que hizo el bind, manteniendo la conexión o permitiendo reconexión de esa misma Session.
- B: flujo actual, nueva `MtprotoSession` + misma temp key + sessionId restaurado.

Registrar exclusivamente metadatos no secretos:

- auth_key_id hash A/B (esperado idéntico; assert explícito);
- dcId + WebSocket hostname (esperado idéntico; assert explícito);
- IP/backend efectivo si el navegador/runtime lo hace observable sin romper TLS/privacy;
- bind req_msg_id y hash de sessionId;
- seqNo/lastMessageId/queued ACK count;
- primer TL outbound;
- presencia/ausencia de initConnection;
- tamaño de payload MTProto y framing length, sin bytes secretos;
- delta bind Bool -> cierre/reuso A -> primer outbound;
- primera respuesta exacta: rpc_result/rpc_error/bad_msg/bad_server_salt/new_session_created/transport 404.

Discriminantes:

- A funciona y B 404 con key ID + hostname iguales -> H1/handoff queda causalmente muy fuerte; si además mismo backend/IP, H3 server-routing cae casi por completo.
- A funciona incluso después de reconectar la misma `MtprotoSession` -> demuestra que cerrar socket no invalida temp key; el defecto es reconstrucción de Session B.
- A también 404 después de cerrar/reconectar pero funciona sin cerrar socket -> aislar temp-key/backend visibility ligada al cambio de conexión.
- A también 404 sin cerrar socket -> revisar binding/temp-key lifecycle antes de tocar handoff.
- B devuelve bad_msg/bad_salt en vez de 404 cuando se corrige sólo transporte/backend -> reevaluar capa exacta.

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

### Pregunta técnica única

¿Qué estado concreto perdido entre Session A y B puede producir específicamente el primer transport 404, en vez de un `bad_msg_notification`, `bad_server_salt`, `new_session_created` o RpcError?

### Evidencia decisiva

1. Telegram dice que `bad_msg_notification` sólo existe cuando el servidor pudo decodificar el mensaje; seqNo bajo, msg_id/time y salt tienen errores tipados específicos.
2. Telegram define `new_session_created` cuando el servidor tiene que crear/recrear una Session después de aceptar un mensaje.
3. El 404 transport permanece en una capa anterior: key lookup o rechazo temprano de MTProto/transport.
4. `_onRpcResult()` confirma más fuerte la explicación del `unknown true`.
5. B importa una copia de la misma key y restaura el mismo sessionId antes de abrir la conexión MAIN/DC objetivo.
6. Los defectos de H1 siguen siendo obligatorios de corregir, pero no había todavía un campo concreto perdido que explicara documentalmente el 404 exacto.

### Impacto en hipótesis

- H1: 99% defecto estructural / 65% causa o prerrequisito directo del primer 404.
- H2: 100% divergencia / 25% causa directa primer 404.
- H3: 35% agregado para temp key no encontrada, routing/DC o envelope/framing temprano.
- H4: 95% defecto / ~70% segundo 404 / 0% primero.
- unknown Bool = replay bind: 94%.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 07:46

### Baseline / duplicate-check

Canonical sigue exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, tree `e8e2e19f430e42852fe963645c882f475e7792a6`. El único PR abierto contra la rama sigue siendo #93, ajeno a Web 12.1. No existe fix posterior ni trabajo duplicado relevante.

### Pregunta técnica única

**¿Puede el primer 404 explicarse por que Session B use un `auth_key_id`, DC/hostname o codec de transporte distinto de Session A antes de entrar a los campos internos de Session?**

### Investigación realizada

Se inspeccionó source exacto de mtcute 0.31.0 para `AuthKey`, `WebSocketTransport` y `TelegramClient` Web, además del código canónico de BeatGaler `webTempAuth.ts` y `webTransport.worker.ts`, contrastándolo con la definición oficial de Session/conexión física y transport 404.

### Evidencia decisiva

1. `AuthKey.setup()` deriva `auth_key_id` únicamente de `SHA1(authKey)[-8]`. B recibe una copia byte-a-byte de la temp key de A. El key ID local no puede divergir.
2. `WebSocketTransport.connect()` ignora `dc.ipAddress`; el hostname WebSocket se deriva sólo de `dc.id` mediante el mismo mapa 1..5.
3. A y B usan el mismo `WebSocketTransport`; B lo recibe por defecto del `TelegramClient` Web.
4. `temp_primary_dcs` preserva el mismo dcId y el seam de PR95 sólo restaura la Session en el main connection de ese mismo DC.
5. A y B usan el mismo `ObfuscatedPacketCodec(IntermediatePacketCodec)`.
6. Telegram define Session como independiente de una conexión física concreta; reemplazar WebSocket no debería por sí solo destruir `(auth_key_id, session_id)`.
7. Telegram sí permite olvidar una temp key antes de expiry, por lo que server-side early discard sigue siendo posible, pero no está demostrado y un fallo inmediato determinista al cambiar socket sería anómalo.

### Resultado

La investigación descarta casi por completo tres subhipótesis H3 locales: key ID distinto, hostname/DC lógico distinto y codec distinto. Esto devuelve peso relativo a H1 por eliminación de alternativas, aunque todavía no identifica qué propiedad B-específica se traduce a 404 en servidor.

### Impacto en hipótesis

- H1: **99% defecto / 75% causa-prerrequisito directo del primer 404**.
- H2: **100% divergencia / 25% causa directa**.
- H3: **25% agregado**, concentrado ya en early discard/backend efectivo o envelope B-específico; mismatch local simple queda ~1%.
- H4: sin cambio.
- unknown Bool replay bind: 94%.

### Conclusiones nuevas invalidadas

- A/B auth_key_id local distinto — descartado.
- A/B hostname/DC lógico distinto por `ipAddress` — descartado.
- A/B codec de transporte distinto — descartado.

### Próximo experimento

A/B con la misma `MtprotoSession` versus handoff B, y dentro del brazo A separar dos variantes: (A1) misma socket; (A2) misma `MtprotoSession` pero socket reconectada. Esto discrimina **reconexión/backend/key visibility** de **reconstrucción de Session** sin mezclar ambos factores.

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

Hay tres defectos/zonas claras y una causa exacta aún sin cerrar:

1. **Handoff PFS/Session inválido:** BeatGaler hace el bind en Session A, destruye A y reconstruye B restaurando sólo parte del estado. Upstream mtcute conserva la misma `MtprotoSession`. Este defecto es 99% seguro.
2. **`initConnection` post-bind suprimido:** contradice documentación oficial y upstream. Es 100% seguro, pero por capa probablemente será un blocker posterior.
3. **Recovery PR95 self-destroy:** tras el primer 404 puede encolar para destroy el mismo sessionId que el seam vuelve a activar; afecta la recuperación/segundo 404, no el primero.
4. **Primer transport 404:** source exacto ya descarta mismatch local de key ID, hostname/DC lógico y codec. Queda por separar reconstrucción de Session versus visibilidad server-side de temp key al cambiar socket/backend.

### Confidence

- H1 handoff incoherente / temp key session-scoped: **99% defecto estructural / 75% causa-prerrequisito directo primer 404**.
- H2 initConnection suprimido: **100% divergencia / 25% causa directa primer 404; alta como blocker posterior**.
- H3 early server discard/backend/envelope temprano: **25% agregado**; sus variantes locales simples están prácticamente descartadas.
- H4 recovery self-destroy: **95% defecto / ~70% segundo 404**.
- unknown Bool = replay bind: **94%**.

### Evidencia nueva más importante de 07:46

- `auth_key_id` de A/B es determinísticamente idéntico porque se deriva de los mismos bytes de key.
- A/B usan exactamente el mismo WebSocket hostname lógico por `dc.id`; `ipAddress` no interviene en WebSocketTransport.
- A/B usan el mismo codec Obfuscated+Intermediate.
- La Session no está atada a una socket concreta según Telegram, así que una reconexión física debería ser soportable.
- El siguiente probe debe separar **misma Session + misma socket**, **misma Session + socket nueva**, y **Session reconstruida B**.

### Fix

Aún NO autorizado. `READY_FOR_IMPLEMENTATION = NO`.

No se modificó producto, no se abrió PR, no hubo merge ni deploy.

### Próximo paso decisivo

Ejecutar el probe runtime de tres brazos:

- A1: bind + primera RPC en misma `MtprotoSession` y misma socket.
- A2: bind + reconectar socket conservando la misma `MtprotoSession` lógica y primera RPC.
- B: handoff productivo actual a nueva `MtprotoSession` con key + sessionId restaurados.

Interpretación:

- A1 y A2 funcionan, B 404 -> reconstrucción de Session es causal con alta confianza y queda listo diseñar fix.
- A1 funciona, A2 y B 404 -> investigar temp-key/backend visibility al cambio de conexión.
- A1 también 404 -> binding/lifecycle previo está roto y no conviene tocar aún el handoff.

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
