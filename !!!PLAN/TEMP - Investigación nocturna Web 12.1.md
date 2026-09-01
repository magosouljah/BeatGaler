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
- HEAD sigue siendo merge de PR #95 y no cambió en los turnos 00:58, 01:45, 02:42, 03:45, 04:43 y 05:44.
- Open PR #93 existe contra la rama pero es un harness Windows F4/25.1 no relacionado con Web 12.1; no se encontró fix posterior ni trabajo duplicado relevante.
- TEMP acumulativo vive en `temp-web-12.1-night-research` porque canonical exige PR y esta investigación prohíbe abrir PR.

### Hechos confirmados

- Lockfile fija `@mtcute/web`, `@mtcute/core` y `@mtcute/wasm` 0.31.0; source upstream exacto: tag `v0.31.0`, commit `11b1c8894b653139b180c13620692f298bc147fb`.
- El 404 observado es un **MTProto transport error**, no HTTP.
- La secuencia productiva coincide con `SessionConnection.handleError()` de mtcute 0.31.0: primer 404 -> reconnect/reset Session; segundo 404 -> reset auth key + reauthorization.
- Web importa la temporary key como auth key primaria y no usa el lifecycle PFS nativo de mtcute.
- `_resetSession()` encola el sessionId viejo para `destroy_session`; PR #95 vuelve a imponer ese mismo ID como activo. Es un defecto concreto posterior al primer 404.
- `webTempAuth.ts` genera una temp key y hace `auth.bindTempAuthKey` manual usando `tempServerSalt`, `tempSessionId`, `msgId` y `seqNo` de la Session A.
- `auth.bindTempAuthKey` devuelve Bool. La respuesta puede quedar sin ACK antes de destruir A; Session B no hereda pending/recent state. Mejor explicación de `unknown ...: true`: replay del Bool de bind. Confidence **92%**.
- El hecho de que Session B pueda descifrar ese `rpc_result true` es evidencia fuerte de continuidad parcial: el auth key ID importado y el sessionId restaurado son compatibles con ese tráfico entrante.
- Telegram exige `initConnection` después de cada `auth.bindTempAuthKey`.
- PR #94/PR #95 fuerzan `session.initConnectionCalled = true`, suprimiendo el `initConnection` real para no exponer API credentials y evitar `CONNECTION_API_ID_INVALID` con `apiId:0`.
- Los artefactos Task 5.1 inspeccionados (`probe-task-5.1-productive-temp-auth-compile.yml`, `regression-web-bound-temp-rpc.mjs`, `regression-task-5.1-hardening.mjs`) no prueban RPC server-side; son build/typecheck o asserts estáticos. El “historical live proof” citado por PR #94 sigue NO VERIFICADO.
- `next.connect()` con auth key ya importada y `disableUpdates:true` no necesita ejecutar autorización y no dispara una RPC de usuario en `onConnectionUsable()`; el primer método API explícito del worker es `next.getMe()`.
- En mtcute 0.31.0 `getMe()` es exactamente `users.getUsers({id:[inputUserSelf]})`.
- Como PR #95 marca `initConnectionCalled=true` antes de abrir la conexión y vuelve a aplicarlo en resets/pool, esa primera `users.getUsers` sale sin wrapper `initConnection`.
- El PFS nativo de mtcute después de bind exitoso conserva la Session, mueve la temporary key secundaria a `_authKeyTemp`, copia `tempServerSalt` y pone `initConnectionCalled=false`. BeatGaler no ejecuta esa transición nativa; exporta key y reconstruye otra Session.
- El bind manual de Session A usa `getSeqNo()` para una RPC content-related y avanza el contador. Session B es un `MtprotoSession` nuevo con `_seqNo=0`; PR #95 restaura el mismo `sessionId` pero no `_seqNo`. Por tanto la primera RPC content-related en B reutiliza un seqNo ya consumido dentro de ese sessionId.
- Telegram documenta `bad_msg_notification` code 32 para seqNo demasiado bajo cuando el paquete se decodifica correctamente. Time/msg_id incorrecto tiene codes 16/17 y server salt incorrecto code 48. Por ello seqNo/salt/time son defectos reales de continuidad, pero no encajan por sí solos como explicación directa de un **transport 404** si el servidor logra decodificar el mensaje.
- `SessionConnection.destroy()` de mtcute no ejecuta `destroyAuthKey()`. Hace `super.destroy()` y después `reset(true)` local. `destroyAuthKey()` es una operación separada que activa `_needDestroyAuthKey` y fuerza un flush explícito. Por tanto `prepared.destroy()` no contiene una ruta normal que invalide server-side la temporary auth key.
- En `MtprotoSession.encryptMessage()`, mtcute usa `_authKeyTemp` sólo si está ready; de lo contrario usa `_authKey`. En Session B `_authKeyTemp` está vacío y la key exportada se importó como `_authKey`, así que el primer paquete productivo se cifra con exactamente la key importada.
- El PFS nativo mantiene permanent key y temp key en ranuras distintas por lifecycle/recovery; la ranura no cambia el `auth_key_id` criptográfico de la key.
- El conjunto de divergencias con errores tipados queda acotado: seqNo bajo -> bad_msg 32; msg_id/time -> bad_msg 16/17; salt -> bad_server_salt 48; falta de initConnection se manifiesta al nivel RPC cuando el paquete ya fue aceptado/descifrado. Ninguna de esas rutas, aislada y correctamente decodificada, es la firma natural de un transport 404.
- Telegram documenta que `(auth_key_id, session_id)` identifica una Session con espacio propio de message IDs, seqNo, salt y acknowledgements. Con PFS, para abrir una Session concurrente nueva no basta cambiar `session_id`: el cliente debe generar y bindear una temporary auth key nueva; cada Session PFS usa su propia temp key.
- `auth.bindTempAuthKey` define `temp_session_id` como el Session ID usado para invocar el bind. Esto confirma que la temp key generada por BeatGaler no es un credential genérico reutilizable libremente entre Sessions.
- Upstream mtcute 0.31.0 confirma la misma semántica: genera temp key, envía bind con `tempSessionId: this._session._sessionId`, espera Bool y después **no crea ni resetea Session**. En la misma `MtprotoSession`, promueve temp key, instala `tempServerSalt`, conserva counters/bookkeeping y fuerza `initConnectionCalled=false`.
- PR #95 acertó en que no podía inventar un sessionId nuevo para reutilizar esa temp key, pero restaurar el ID viejo sobre un `MtprotoSession` recién creado fabrica una “continuación” cuyo identificador dice Session A mientras counters/ACK/salt/bookkeeping dicen Session nueva.
- **NUEVO TURNO 05:44:** documentación oficial de transports vuelve a acotar el primer 404: `404` transport significa auth key no encontrada por el DC o un fallo MTProto/transport suficientemente temprano; no es un error RPC de método.
- **NUEVO TURNO 05:44:** Telegram además dice que una temporary auth key puede desaparecer server-side antes de `expires_at`, precisamente produciendo 404. Esto mantiene una pequeña rama H3, pero no explica por sí solo por qué la falla es inmediata/repetible justo tras el handoff.
- **NUEVO TURNO 05:44:** la omisión de `initConnection` sigue siendo 100% divergente del protocolo, pero si el servidor llega a interpretar la RPC, el fallo pertenece a la capa RPC; por eso H2 pierde peso como explicación del **primer transport 404** y queda más probable como blocker posterior que aparecerá después de reparar la continuidad de Session.
- **NUEVO TURNO 05:44:** el source exacto de mtcute trata un 404 bajo PFS como “temp key olvidada” y lanza reautorización PFS; BeatGaler, al importar la temp key como primary con `usePfs:false`, pierde precisamente esa semántica y entra en recovery genérico de permanent key.
- WASM MIME sigue SECONDARY: fallback alcanza MAIN y procesa MTProto antes del 404.

### Hipótesis activas

#### H1 — handoff/reconstrucción incoherente de la Session bound

- confidence: **99% como defecto estructural**; **90% como causa o prerrequisito directo del primer 404**.
- descripción: bind ocurre en Session A y la primera RPC en Session B. La temp key PFS es session-scoped: no puede tratarse como una auth key genérica para una Session nueva. PR #95 mantiene el `sessionId` correcto pero lo monta sobre estado nuevo, creando una continuación internamente contradictoria.
- evidencia: Telegram define estado por `(auth_key_id, session_id)` y exige nueva temp key para nueva Session PFS; upstream mantiene la misma `MtprotoSession` tras bind; BeatGaler reinicia `_seqNo`, `_lastMessageId`, pending/recent/ACK/salt/lifecycle y sólo restaura `_sessionId`.
- matiz: todavía no está demostrado qué condición exacta convierte esa incoherencia en 404 en producción; un A/B live sigue siendo el discriminante decisivo.
- discriminante: primera RPC ejecutada en la misma `MtprotoSession` A vs handoff B.

#### H2 — `initConnection` post-bind suprimido

- confidence: **100% como divergencia de protocolo**; **35% como causa directa del primer 404**; **alta probabilidad de blocker posterior**.
- a favor: requisito oficial y upstream pone `initConnectionCalled=false` tras bind PFS.
- en contra como primer 404: `initConnection` vive en capa API/RPC; un transport 404 se emite por debajo de esa capa cuando la key/paquete MTProto no es aceptado suficientemente para producir un RpcError normal.
- discriminante: después de conseguir continuidad válida de Session, comparar initConnection real vs seam artificial.

#### H3 — DC/key mismatch, key destruida o temporary key desaparecida

- confidence: **3% para mismatch/destrucción cliente; 10% agregado incluyendo desaparición server-side**.
- contra mismatch/destrucción cliente: mismo DC en generación/bind/export; B descifra replay Bool; `destroy()` no llama `destroyAuthKey()`; outbound B usa la key importada en `_authKey`.
- todavía posible: Telegram puede olvidar temp keys antes de expiry y lo documenta como causa directa de 404.
- contra como explicación principal: reproducibilidad inmediata justo tras handoff y continuidad parcial observada.
- discriminante: registrar hash de auth_key_id/DC y timestamp exacto entre bind Bool y primer 404 en A/B.

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
- `salt/time/seqNo son intercambiables como causas genéricas de 404` — INVALIDADA; tienen respuestas MTProto específicas si el paquete se decodifica.
- `prepared.destroy()` destruye server-side la temporary auth key — DESCARTADA para la ruta normal de mtcute 0.31.0.
- `Session B puede estar cifrando accidentalmente con otra key local` — MUY IMPROBABLE.
- `una temporary auth key bound puede reutilizarse como auth key genérica en cualquier Session nueva del mismo DC` — INVALIDADA por documentación PFS.
- `si se conserva el mismo sessionId, una MtprotoSession recién creada equivale protocolariamente a continuar la Session anterior` — INVALIDADA.
- **NUEVO:** `la falta de initConnection es la explicación más directa del primer transport 404` — DEBILITADA; sigue siendo un bug obligatorio de corregir, pero su capa natural es RPC/API, no transport.

### Primera secuencia productiva identificada

1. Session A abre socket y genera temp key.
2. A manda `auth.bindTempAuthKey` bajo `tempSessionId`; consume estado content-related.
3. A recibe `Bool true`; ACK puede quedar pendiente.
4. Upstream correcto seguiría usando esa misma `MtprotoSession` A, promovería la temp key, instalaría temp salt y forzaría initConnection real.
5. BeatGaler destruye A localmente y crea Session B desde cero.
6. B importa la misma temp key como `_authKey`.
7. PR #95 restaura el `sessionId` de A sobre B, pero no el resto de estado de A.
8. B puede recibir replay del `Bool true`, pero no reconoce su `req_msg_id`.
9. B mantiene `_seqNo=0`, `_lastMessageId` nuevo, ACK/pending/recent state vacío, salt/lifecycle reconstruido y `initConnectionCalled=true` artificial.
10. Primera RPC productiva: `users.getUsers(inputUserSelf)`.
11. Antes de que exista evidencia de un RpcError de esa llamada, producción reporta transport 404.

### Estado transferible entre conexiones — clasificación actualizada

| Estado | Clasificación | Nota |
|---|---|---|
| authKey bytes | REQUIRED | presente y usada por B |
| authKey slot `_authKey` vs `_authKeyTemp` | lifecycle REQUIRED | diseño actual rompe PFS recovery |
| tempSessionId | REQUIRED para continuar esa temp key/session | presente por PR95 |
| `_seqNo` | REQUIRED al conservar mismo sessionId | B lo reinicia |
| `_lastMessageId` / monotonic msg state | REQUIRED al continuar misma Session | B lo reinicia |
| pending bind request / recent outgoing | debe resolverse o continuarse coherentemente | perdido; explica unknown Bool |
| pending ACK del bind | debe flush/resolverse o continuarse | puede perderse |
| temp server salt | REQUIRED para transición limpia | upstream lo instala en misma Session; BeatGaler no lo transfiere explícitamente |
| time offset | relevante | no transferido explícitamente |
| key temporal/PFS semantics | REQUIRED para expiry/recovery | hoy temp key se trata como primary |
| `initConnectionCalled` | debe quedar false post-bind hasta initConnection real | hoy se fuerza true |
| socket física | NOT REQUIRED | puede reemplazarse sin crear nueva Session lógica |
| `MtprotoSession` lógica | **DE FACTO REQUIRED para este bind**, salvo serialización completa del estado | upstream la conserva; BeatGaler la reemplaza |
| nueva Session con misma temp key | **NOT VALID PFS MODEL** | Telegram exige nueva temp key por nueva Session |
| server-side key destruction al cerrar A | NOT EXPECTED | `destroy()` no llama `destroyAuthKey()` |

### Mejor explicación actual del `unknown rpc_result true`

Replay del `rpc_result` del `auth.bindTempAuthKey` exitoso cuyo ACK/pending bookkeeping quedó en Session A. Confidence **92%**. Falta correlación numérica de `req_msg_id`, pero tipo Bool, orden y handoff encajan.

### Mejor explicación actual del primer 404

La evidencia dominante sigue siendo que B se presenta como continuación de la Session PFS bound usando la misma temp key + mismo sessionId, pero genera el siguiente envelope desde una `MtprotoSession` recién nacida.

El nuevo acotamiento de capa refuerza esa lectura: si el problema fuera únicamente `users.getUsers` sin `initConnection`, esperaríamos llegar a una respuesta de nivel RPC. El transport 404 ocurre antes, compatible con que el DC no acepte la temp key/MTProto envelope como una continuación válida o con que la temporary key haya desaparecido server-side.

No está demostrado todavía si el servidor devuelve 404 específicamente por una inconsistencia de Session que no se expresa como bad_msg, o si la key temporal es olvidada entre A y B. El A/B de misma Session elimina esa ambigüedad de una sola vez.

### Próximo experimento de máximo valor

**A/B de continuidad lógica, una sola variable:**

- A: bind manual y primera `users.getUsers(inputUserSelf)` en la **misma `MtprotoSession`** que hizo el bind, tras transición PFS correcta y post-bind initConnection apropiado.
- B: flujo actual, creando nueva `MtprotoSession` y restaurando sólo datos exportados.

Registrar sólo metadatos no secretos:

- hash/auth_key_id;
- sessionId hash;
- DC;
- bind req_msg_id;
- seqNo/lastMessageId;
- queued ACKs;
- primer TL outbound;
- presencia de initConnection;
- delta temporal bind->primer RPC;
- respuesta/error exacto.

Discriminantes:

- A funciona y B 404 -> H1 queda causalmente aislada y `READY_FOR_IMPLEMENTATION` puede pasar a YES para eliminar el handoff incompleto.
- A también 404 -> subir H3 y revisar bind/key/DC/TTL antes de tocar arquitectura.
- A funciona sólo con initConnection real -> H1 + H2 deben corregirse juntas.

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
6. B reutiliza un seqNo content-related ya consumido dentro del mismo sessionId.
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
2. B cifra con `_authKey` que contiene exactamente la temp key exportada.
3. El replay Bool descifrado en B demuestra continuidad criptográfica parcial.
4. seqNo/msg_id/salt/initConnection tienen errores más específicos si la capa cifrada se acepta.
5. El primer 404 apunta más a aceptación del envelope/temp-key/session como conjunto.

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

H1 pasa a incompatibilidad concreta con el modelo PFS: la temp key es session-scoped y el handoff actual no conserva la Session lógica que la bindió.

### Impacto en hipótesis

- H1 99% defecto estructural / 87% causa-prerrequisito primer 404.
- H2 100% divergencia / 55% causa directa.
- H3 3% mismatch/destrucción cliente; 8% agregado.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 05:44

### Baseline / duplicate-check

Canonical sigue exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, tree `e8e2e19f430e42852fe963645c882f475e7792a6`. Sin fix posterior ni trabajo duplicado relevante para Web 12.1.

### Pregunta técnica única

**¿La omisión de `initConnection` puede seguir siendo la explicación principal del primer transport 404, o la capa exacta del error obliga a priorizar temp-key/session/envelope?**

### Investigación realizada

Se contrastó nuevamente documentación oficial de MTProto transports, PFS y bind con el `handleError()` exacto de mtcute v0.31.0.

### Evidencia decisiva

1. Telegram define transport 404 como auth key no encontrada por el DC o fallo temprano de MTProto/transport; ocurre por debajo de un RpcError normal.
2. Telegram documenta que una temp key puede desaparecer server-side antes de `expires_at` y eso produce precisamente 404.
3. `initConnection` es requisito post-bind, pero pertenece al payload API una vez que el mensaje MTProto fue aceptado/descifrado.
4. Por ello la falta de initConnection sigue siendo un defecto seguro, pero ya no es la explicación de capa más directa para el **primer** 404.
5. Mtcute reconoce esta semántica: con PFS activo un 404 dispara regeneración/rebind de temp key; BeatGaler ha perdido esa semántica al importar la temp key como primary con `usePfs:false`.
6. La reproducibilidad inmediata tras el handoff mantiene H1 por encima de la hipótesis de desaparición aleatoria server-side.

### Impacto en hipótesis

- H1: **99% defecto estructural / 90% causa-prerrequisito primer 404**.
- H2: **100% divergencia / 35% causa directa primer 404**, probable blocker posterior.
- H3: **3% mismatch/destrucción cliente / 10% agregado incluyendo temp key olvidada server-side**.
- H4: sin cambio.

### Conclusión invalidada/debilitada este turno

“La falta de initConnection es la candidata principal para el primer transport 404” — DEBILITADA. Debe corregirse, pero el orden causal más probable ahora es: primero continuidad PFS/temp-key/session; después initConnection válido.

### Próximo experimento

A/B runtime misma `MtprotoSession` A vs handoff B actual. Añadir delta temporal bind->primer outbound y auth_key_id/DC hash para distinguir Session inválida de temp key realmente olvidada.

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

La evidencia es ahora más específica: el modelo actual viola la continuidad PFS de la Session y, además, trata una temporary auth key como permanent/primary desde la perspectiva de mtcute.

Telegram trata `(auth_key_id, session_id)` como una Session con estado propio. Bajo PFS, una Session nueva necesita su propia temporary auth key y su propio bind. Upstream mtcute conserva la misma `MtprotoSession` después del bind; BeatGaler destruye A, crea B y restaura sólo el sessionId.

El acotamiento nuevo de este turno separa mejor los dos defectos principales:

1. **H1 / continuidad PFS** encaja con el primer fallo a nivel transport.
2. **H2 / initConnection suprimido** sigue siendo obligatorio corregir, pero probablemente aparecerá como problema posterior una vez que el envelope/temp-key/session sea aceptado.

### Confidence

- H1 handoff incoherente / temp key session-scoped: **99% defecto estructural / 90% causa-prerrequisito primer 404**.
- H2 initConnection suprimido: **100% divergencia / 35% causa directa primer 404; alta como blocker posterior**.
- H3 mismatch/destrucción cliente: **3%**; incluyendo desaparición server-side: **10%**.
- H4 recovery self-destroy: **95% defecto / ~70% segundo 404**.
- unknown Bool = replay bind: **92%**.

### Evidencia nueva más importante de 05:44

Transport 404 ocurre por debajo del nivel RpcError. Eso reduce fuertemente la probabilidad de que la falta de `initConnection` sea por sí sola la causa del primer 404 y refuerza que el primer fallo está en la aceptación de la temp key/Session/envelope o en una temp key olvidada server-side.

El comportamiento nativo de mtcute también es informativo: si usa PFS y recibe 404, asume que la temp key pudo desaparecer y la regenera/rebindea. El Web actual no puede hacer eso porque ha importado la temporary key como primary con `usePfs:false`.

### Fix

Aún NO autorizado. Falta el A/B runtime que confirme que mantener Session A elimina el primer 404 y mida si la temp key sigue viva exactamente en el momento del primer outbound.

No se modificó producto, no se abrió PR, no hubo merge ni deploy.

### Próximo paso decisivo

Ejecutar un probe runtime de una sola variable:

- flujo A: bind y primera RPC en la misma `MtprotoSession`;
- flujo B: handoff actual a Session nueva restaurando IDs.

Registrar auth_key_id/DC hash y delta bind->primer outbound además del estado de Session.

Si A funciona y B falla, el fix queda suficientemente aislado para implementación. Si A también 404, revisar expiración/retención server-side de temp key y bind antes de tocar arquitectura.

### Archivos probablemente involucrados cuando READY sea YES

- `src/features/cloud/webTempAuth.ts`
- `src/features/cloud/webTransportSession.ts`
- `src/features/cloud/webTransport.worker.ts`
- nueva regresión/probe runtime real de bound temp auth

### Validación futura mínima

bind -> misma Session lógica -> temp-key PFS lifecycle válido -> initConnection post-bind válido -> `getMe` correcto -> `getChat`/library browse, sin unknown bind replay, sin bad_msg, sin transport 404 y sin reconnect/reauthorize loop.

### No tocar todavía

WASM MIME, SSL/SNI y términos internos son secundarios. No eliminar TEMP hasta cerrar el bloqueo.

State: `CONTINUE_INVESTIGATION`