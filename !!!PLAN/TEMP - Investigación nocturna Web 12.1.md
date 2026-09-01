# TEMP — Investigación nocturna Web 12.1

> Archivo temporal. Eliminar después de resolver el bloqueo.

## ESTADO ACUMULADO

### Síntoma principal actual

Producción posterior a PR #95 llega a conexión Web MAIN real y después reproduce esta secuencia:

1. `received rpc_result for unknown message <id>: true`
2. `transport error 404. trying to reconnect`
3. `transport error 404, reauthorizing`
4. `Transport error: 404`
5. `Galer Cloud Web transport timed out during verify`

El ciclo tarda aproximadamente 35–36 s por intento y vuelve a iniciar reload.

Task 12.1 sigue NO terminada.

### Hechos confirmados

- Baseline de código investigado: `integration-v0.8.0-alpha.1` @ `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`.
- Ese HEAD es el merge de PR #95 (`F2/12.1: preserve bound temporary Web session id`).
- No se encontró un PR posterior relacionado con Task 12.1 en el preflight de este turno.
- PR #95 y sus checks relevantes pasaron CI, pero la evidencia de producción posterior demuestra que preservar únicamente `tempSessionId` no resolvió el fallo.
- PREVIOUS CONCLUSION INVALIDATED: la conclusión de PR #95 de que preservar únicamente el bound temporary session id solucionaría el transport 404 queda invalidada por la ejecución productiva posterior.
- Lockfile actual fija `@mtcute/web` **0.31.0**. El source upstream exacto corresponde a tag `v0.31.0`, commit `11b1c8894b653139b180c13620692f298bc147fb` de `mtcute/mtcute`.
- En `packages/core/src/network/transports/intermediate.ts` de mtcute 0.31.0, un frame de transporte de exactamente 4 bytes se interpreta como código MTProto transport y se lanza `TransportError(-code)`. Por tanto el 404 observado no es un HTTP 404.
- La documentación oficial de MTProto define 404 de transporte principalmente como `auth key not found`, aunque también puede aparecer durante operación normal si existen campos/encapsulado MTProto incorrectos.
- En `SessionConnection.handleError()` de mtcute 0.31.0, la secuencia productiva coincide exactamente con la rama genérica de 404:
  - primer 404: `transport error 404. trying to reconnect` -> `_resetSession('-404 reconnect')`;
  - segundo 404: `transport error 404, reauthorizing` -> `resetAuthKey()` + otro `_resetSession` + señal `onKeyChange(null)`.
- La ejecución NO está entrando en la rama normal de recuperación PFS (`transport error 404, reauthorizing pfs`). El Web productivo importa la key temporal mediante `TelegramClient.importSession(...)` con `usePfs: false`, por lo que mtcute la trata como key primaria del Session importado.
- `_resetSession()` en mtcute 0.31.0 primero encola el `sessionId` actual para `mt_destroy_session`, luego ejecuta `session.resetState(true)`, falla/reencola requests pendientes y reconecta.
- `Session.resetState(true)` crea un sessionId nuevo y reinicia estado como `lastMessageId`, `seqNo`, conjuntos de message IDs y ACK queues, manteniendo ciertos pending messages.
- PR #95 envuelve `session.resetState()` y vuelve a imponer inmediatamente el sessionId bound anterior. Esto rompe una invariancia interna de `_resetSession()`: el ID viejo queda en la cola de `destroy_session` y, tras el wrapper, ese mismo ID vuelve a ser el Session activo. Por tanto el recovery puede intentar destruir el mismo sessionId que BeatGaler acaba de reactivar. Esto es un defecto concreto del recovery de #95, aunque no explica el **primer** 404.
- `src/features/cloud/webTempAuth.ts` crea una `ManualSessionConnection`, genera la temporary auth key, prepara un `msgId`, `nonce`, `tempSessionId`, ejecuta manualmente `auth.bindTempAuthKey` y espera un `Bool true`.
- Ese bind registra `pendingMessages.set(msgId, { _: 'bind', ... })`; tras recibir respuesta, mtcute resuelve el pending y elimina la entrada.
- En mtcute 0.31.0, la respuesta RPC del bind se ACKea mediante `_sendAck(messageId)`. El ACK se acumula en `queuedAcks`; si es el primer ACK, el flush se programa hasta 30 s después salvo otra actividad que fuerce flush.
- `src/features/cloud/webTransportSession.ts` llama `prepared.bind(...)` y, en `finally`, ejecuta inmediatamente `prepared.destroy()`. Por tanto existe una ruta real donde el `Bool true` del bind fue recibido pero su ACK todavía no salió antes de destruir la conexión auxiliar.
- MTProto documenta que una respuesta RPC no recibida/acknowledged puede ser reenviada en una oportunidad posterior y que `rpc_result.req_msg_id` identifica el request original.
- Luego BeatGaler crea **otro** `TelegramClient` con `MemoryStorage` nuevo, importa únicamente key/DC/self y fuerza el mismo `tempSessionId`. Su `pendingMessages` y `recentOutgoingMsgIds` no contienen el `msgId` del bind de la conexión auxiliar.
- En mtcute 0.31.0 el warning `received rpc_result for unknown message ...` sólo aparece cuando el `req_msg_id` no corresponde a un pending del Session actual y tampoco está en `recentOutgoingMsgIds`. Una respuesta duplicada de un request reciente se registraría sólo como `debug`.
- `auth.bindTempAuthKey` devuelve oficialmente `Bool`; por la secuencia de código, el ACK pendiente y la reconstrucción con el mismo key/sessionId, la mejor explicación actual del `...: true` es un `rpc_result` reenviado del bind exitoso original. Confidence actual: **90%**. Falta correlacionar el `req_msg_id` de producción con `prepared.metadata.msgId` para convertirlo en identificación definitiva.
- La documentación oficial exige ejecutar `initConnection` después de cada `auth.bindTempAuthKey`.
- PR #94 introdujo explícitamente el seam que marca `session.initConnectionCalled = true` para impedir que mtcute envíe el primer `initConnection` con `apiId=0`; el código actual sigue suprimiendo ese `initConnection`. Por tanto existe una divergencia protocolaria demostrable entre la especificación y Web productivo. Todavía NO está demostrado que sea la causa del transport 404.
- El warning WASM MIME no impide que el runtime llegue a MAIN ni que reciba un `rpc_result`; por ahora se clasifica como **WASM MIME SECONDARY**, no root cause del 404.

### Hipótesis activas

#### H1 — reconstrucción incompleta de una sesión bound entre dos clientes

- confidence: **78%**
- descripción: el bind ocurre en una `ManualSessionConnection`, pero la primera RPC productiva ocurre en otro `TelegramClient`/`Session` creado desde cero. Copiar auth key + DC + self + sessionId no recrea todo el estado semántico de la sesión MTProto que el servidor mantiene para `(auth_key_id, session_id)`.
- evidencia a favor:
  - `webTempAuth.ts` y `webTransport.worker.ts` confirman dos objetos Connection/Session distintos;
  - el servidor puede mantener estado por session y reenviar respuestas no ACKeadas;
  - el `Bool true` reaparece en el cliente reconstruido sin pending map correspondiente;
  - `Session.resetState()` trata sessionId, seqNo, message IDs, ACKs y pending state como estado acoplado;
  - #95 copió sólo sessionId y no resolvió producción;
  - el wrapper de #95 crea un estado híbrido y puede auto-destruir el ID restaurado tras el primer 404.
- evidencia en contra:
  - aún no se ha demostrado cuál de los campos restantes es indispensable para el primer RPC;
  - MTProto sí soporta reconectar una misma sesión sobre otra conexión física, por lo que la `Connection` física en sí no tiene por qué ser preservada.
- experimento discriminante: en un probe diagnóstico, mantener mismo key/DC/bind y variar sólo el handoff: A) primer RPC productivo sobre el mismo `SessionConnection` que hizo bind; B) primer RPC sobre `TelegramClient` reconstruido exactamente como Web. Si A funciona y B falla, la reconstrucción queda aislada como causa.

#### H2 — `initConnection` post-bind suprimido

- confidence: **60%**
- descripción: después del bind exitoso, Web marca artificialmente `initConnectionCalled=true` y ejecuta `getMe()` sin el `initConnection` que la especificación exige después de cada bind.
- evidencia a favor:
  - requisito explícito de la documentación oficial PFS/invoking;
  - PR #94 introdujo exactamente la supresión para eliminar `CONNECTION_API_ID_INVALID` de mtcute high-level;
  - el primer tráfico productivo posterior al bind nace bajo esta divergencia.
- evidencia en contra:
  - el comentario de PR #94 afirma que probes Task 5.1 habían logrado RPC productiva sin exponer credenciales de aplicación;
  - todavía no existe una traza que vincule falta de `initConnection` con un transport 404 en este caso concreto.
- experimento discriminante: comparar dos probes idénticos sobre el mismo bound Session: uno ejecuta el `initConnection` requerido con credenciales válidas de forma segura fuera del browser y otro reproduce el seam `initConnectionCalled=true`; observar si sólo el segundo entra en 404.

#### H3 — DC/key mismatch o temporary key inexistente en el DC elegido

- confidence: **20%**
- descripción: el primer 404 podría ser el significado primario `auth key not found` por key en DC incorrecto o key descartada.
- evidencia a favor:
  - 404 documentado puede significar auth key no encontrada;
  - DC 1 todavía no fue auditado contra binding/server metadata en este turno.
- evidencia en contra:
  - `prepareWebTempAuth(dcId)` genera y bindea la key en el mismo `dcId` que luego exporta como `primaryDcs`;
  - la repetición determinista inmediatamente después del bind hace menos probable una expiración aleatoria temprana;
  - la reaparición probable del `rpc_result` del bind bajo la sesión importada es evidencia de continuidad de key/session, aunque falta correlación de IDs.
- experimento discriminante: registrar únicamente dcId, hash de auth_key_id y req_msg_id hash en bind e initialize para demostrar igualdad sin exponer key.

#### H4 — el recovery de PR #95 agrava el primer 404 destruyendo el mismo sessionId restaurado

- confidence: **95% como defecto de código; 70% como explicación del segundo 404**
- descripción: `_resetSession()` encola old sessionId para destrucción y espera que `resetState(true)` genere otro ID; el wrapper de #95 vuelve a poner old ID, por lo que el reconnect puede emitir `destroy_session(oldId)` mientras oldId vuelve a ser el Session activo.
- evidencia a favor: secuencia directa del source exacto de mtcute + wrapper actual de BeatGaler.
- evidencia en contra: no puede originar el primer 404 porque sólo se ejecuta después de recibirlo.
- experimento discriminante: instrumentar hashes del ID en `_queuedDestroySession` y `_session._sessionId` después del primer 404; no cambiar comportamiento.

### Hipótesis descartadas

- **“404 es HTTP 404” — DESCARTADA.** Source exacto `intermediate.ts` demuestra frame MTProto de 4 bytes convertido en `TransportError(404)`.
- **“preservar únicamente tempSessionId es suficiente” — DESCARTADA.** PR #95 lo implementó, pasó CI, se desplegó y producción conserva el mismo fallo.
- **“WASM MIME es la causa raíz del transport 404” — DESCARTADA por ahora como root cause.** El fallback WebAssembly continúa, abre MAIN y procesa tráfico MTProto antes del 404. Sigue siendo bug secundario.

### Preguntas abiertas

1. ¿El `req_msg_id` del `Bool true` coincide exactamente con `prepared.metadata.msgId` de `auth.bindTempAuthKey`?
2. ¿Qué primer mensaje saliente del `TelegramClient` reconstruido provoca el primer transport 404: ACK del bind reenviado, `getMe`, ping, destroy/session control u otro?
3. ¿La falta de `initConnection` post-bind explica por sí sola el primer 404 o produce otro tipo de error?
4. ¿Qué estado mínimo de Session debe sobrevivir si se continúa el mismo `(auth_key_id, session_id)`?
5. ¿Qué working probe histórico de Task 5.1 realizó una RPC real y cuál fue la primera divergencia interna respecto a Web productivo?
6. ¿DC 1 es el DC correcto para la key de los intentos observados?

### Diferencias working probe vs producción

Comparación todavía incompleta; no declarar conclusión final hasta estudiar los harness históricos reales.

| Dimensión | Working probe histórico | Web productivo actual | Estado |
|---|---|---|---|
| Evidencia disponible | El repo conserva workflow/harness Task 5.1 y PR #94 afirma que una bound temporary key hizo RPC de aplicación | `webTempAuth.ts` hace bind manual y luego `webTransport.worker.ts` crea otro TelegramClient | PARCIAL |
| Connection que hace bind | pendiente de confirmar probe exacto | `ManualSessionConnection` auxiliar | CONFIRMADO WEB |
| Connection que hace primer RPC productivo | pendiente | `TelegramClient` nuevo / NetworkManager nuevo | CONFIRMADO WEB |
| Estado transferido | pendiente | auth key + primaryDcs + self + tempSessionId | CONFIRMADO WEB |
| Pending bind ACK | pendiente | puede quedar en `queuedAcks` al destruir conexión inmediatamente | CONFIRMADO WEB |
| `initConnection` después del bind | pendiente | suprimido artificialmente con `initConnectionCalled=true` | CONFIRMADO WEB |
| PFS handling nativo mtcute | pendiente | no; `usePfs:false` + import de temp key como primary key | CONFIRMADO WEB |

La comparación completa de Task 5.1 queda como investigación prioritaria de un turno posterior; este turno se concentró en la semántica del 404 y el `Bool true` relacionado.

### Estado transferible entre conexiones

| Estado | REQUIRED | NOT REQUIRED | UNKNOWN | Evidencia |
|---|---:|---:|---:|---|
| authKey bytes | ✅ |  |  | Necesaria para cifrado y es lo que el servidor identifica mediante auth_key_id. |
| authKeyId como campo separado |  | ✅ |  | Se deriva criptográficamente de authKey; no necesita serialización independiente. |
| auth key type / temporal semantics en el cliente | ✅ |  |  | El servidor ve la key; el cliente necesita saber que es temporal para expiry/recovery PFS. Web actual la instala como key primaria y entra en recovery genérico. |
| temporary key expiry | ✅ |  |  | Necesaria para renewal correcto; no demuestra el primer 404. |
| tempSessionId / sessionId bound | ✅ |  |  | `bind_auth_key_inner` incluye `temp_session_id`; cada PFS main session genera/bindea su temp key. |
| server salt |  |  | ✅ | Forma parte de cada mensaje MTProto; falta demostrar si debe transferirse o puede reaprenderse de forma segura tras handoff. |
| seqNo |  |  | ✅ | `resetState` lo reinicia; falta prueba de qué exige el servidor al continuar exactamente el mismo sessionId. |
| lastMessageId / MessageIdGenerator state |  |  | ✅ | `resetState` lo reinicia; continuidad exacta aún no probada. |
| time offset |  |  | ✅ | Afecta generación válida de msg_id; no hay evidencia todavía de drift en producción. |
| pending RPC map |  |  | ✅ | El warning prueba que falta al menos el request del resultado reenviado. Puede evitarse transfiriendo estado o completando/ACKeando antes del handoff. |
| pending acknowledgements | ✅ |  |  | El bind Bool puede quedar ACK-pending; debe flush/transfer/resolverse antes de abandonar la sesión. |
| recent outgoing request/message map |  |  | ✅ | Su ausencia convierte el Bool reenviado en “unknown”; efecto funcional adicional todavía no demostrado. |
| physical WebSocket transport |  | ✅ |  | MTProto permite reconectar una sesión en otra conexión física; no es necesario conservar el socket por sí mismo. |
| Connection object |  |  | ✅ | La conexión física no es necesaria, pero falta probar si el estado encapsulado que no se exporta sí lo es. |
| Session object |  |  | ✅ | Hipótesis principal: el estado del Session puede ser la unidad mínima correcta; probe A/B pendiente. |
| `initConnectionCalled=true` |  | ✅ |  | No debe “transferirse” como sustituto de protocolo: la especificación exige `initConnection` después de bind. |
| DC / primary DC | ✅ |  |  | La key debe usarse en el DC que la conoce. DC exacto de producción aún pendiente de auditoría. |
| media DC |  |  | ✅ | Fuera del camino crítico de startup MAIN de este turno. |
| PFS state / expiry / reauthorization mode | ✅ |  |  | Sin ello mtcute interpreta 404 como key primaria y borra auth en segundo 404 en vez de recovery PFS. |
| reconnect state |  |  | ✅ | `_triedReconnectingOn404` determina primer vs segundo 404. |
| resetState coupling | ✅ |  |  | #95 rompe el acoplamiento esperado entre `queuedDestroySession` y el nuevo sessionId. |
| NetworkManager state |  |  | ✅ | No investigado aún de forma suficiente. |
| connection pool state |  |  | ✅ | MAIN primero; upload/download fuera del problema principal inmediato. |

### Mejor explicación actual del unknown rpc_result

**Confidence: 90%.**

El `Bool true` es muy probablemente el `rpc_result` de `auth.bindTempAuthKey` que ya fue recibido en la conexión auxiliar pero quedó sin ACK en el servidor cuando BeatGaler destruyó esa conexión. La respuesta de bind es `Bool`; mtcute programa su ACK hasta 30 s; BeatGaler destruye la conexión inmediatamente; después reutiliza la misma key + sessionId en otro Session vacío. El servidor puede reenviar una respuesta RPC pendiente de ACK en una sesión reanudada. El nuevo Session no posee ni el pending bind ni el outgoing msgId original, así que mtcute registra exactamente `received rpc_result for unknown message <req_msg_id>: true`.

No se eleva a 100% hasta correlacionar, sin secretos, el `req_msg_id` observado con el `msgId` creado en `prepareWebTempAuth()`.

### Mejor explicación actual del transport 404

El 404 es un MTProto transport error, no HTTP. El source exacto de mtcute confirma que el primer 404 provoca reset/reconnect y el segundo borra la auth key/reautoriza.

La causa del **primer** 404 todavía no está demostrada. La explicación líder es que el primer tráfico productivo sale desde un Session reconstruido que sólo conserva parte del estado de la sesión bound y, además, se salta el `initConnection` post-bind requerido. Una key/DC totalmente incorrecta queda menos probable, pero no descartada.

Después del primer 404 existe un segundo defecto demostrable: #95 restaura el sessionId que mtcute acaba de encolar para `destroy_session`, de modo que el recovery puede destruir el mismo ID activo y convertir un fallo recuperable en el segundo 404 + reauth.

### Relación probable entre ambos

1. Bind manual responde `true` en Session A.
2. Su ACK puede quedar en cola; Session A se destruye.
3. Web crea Session B, instala misma auth key + mismo sessionId pero no el bookkeeping de A.
4. El servidor reenvía el `rpc_result(true)` pendiente del bind a la sesión reanudada.
5. Session B no conoce `req_msg_id` -> warning `unknown message ...: true`.
6. Session B comienza/continúa tráfico productivo con estado reconstruido y sin `initConnection` post-bind -> primer 404 por una condición aún por aislar.
7. mtcute intenta reset/reconnect; seam #95 vuelve a poner el ID que `_resetSession` acaba de marcar para destrucción.
8. El recovery queda contaminado y aparece segundo 404 -> mtcute borra auth key y entra en reauthorization genérica.

Esto explica fuertemente por qué unknown Bool y 404 aparecen juntos y por qué PR #95 no bastó, pero el paso 6 sigue siendo el gap causal principal.

### Mejor siguiente experimento

Probe diagnóstico A/B, una sola variable:

- mismos DC, permanent binding, temporary auth key y TTL;
- **A:** después de `auth.bindTempAuthKey=true`, ejecutar el primer RPC productivo sobre el mismo `SessionConnection`/Session, asegurando además que el ACK del bind se haya flushado;
- **B:** después del mismo bind, reproducir el handoff actual hacia un `TelegramClient` nuevo con key + DC + sessionId;
- registrar únicamente hashes no reversibles de `auth_key_id`, sessionId, req_msg_id, pending count, queued ACK count, seqNo/lastMessageId y si `initConnection` fue enviado;
- señal discriminante: A success + B 404 aísla reconstrucción; A y B 404 desplaza prioridad a key/DC/binding; B sólo funciona cuando se ejecuta `initConnection` aísla H2.

Antes de tocar producción, agregar correlación del `prepared.metadata.msgId` con el req_msg_id del warning para confirmar definitivamente la identidad del Bool.

### Problemas secundarios reales

- **P0:** recovery de #95 puede encolar `destroy_session(oldId)` y después restaurar `oldId` como Session activo. Riesgo de auto-destrucción después del primer 404.
- **P1:** el flujo suprime `initConnection` después del bind pese al requisito protocolario. Debe resolverse sin exponer credenciales permanentes al browser.
- **P1:** cada fallo de verify consume ~35 s y luego puede reiniciar reload; riesgo de retry storm/zombie worker pendiente de inspección.
- **P2:** `.wasm` se sirve con MIME incorrecto; `instantiateStreaming` falla y cae a fallback. Funciona, pero degrada startup y ensucia diagnóstico.
- **P2:** health-check SSL del deploy puede recibir un certificado SAN incorrecto para `beatgaler.com`; separado del transport 404 y pendiente de diagnóstico nginx.
- **P2:** terminología interna (`Telegram`, `MTProto`, `mtcute`) aparece en logs técnicos/browser console. Debe revisarse antes de alpha si alcanza superficies user-facing.

### READY_FOR_IMPLEMENTATION

NO

# CRONOLOGÍA DE INVESTIGACIÓN

## TURNO 2026-09-01 00:58

### Baseline

canonical branch: `integration-v0.8.0-alpha.1`
canonical HEAD: `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`
PRs nuevos: ninguno posterior a PR #95 relacionado con Task 12.1 detectado en el preflight.
CI relevante: PR #95 pasó Secret Scan, D6 authorization, Productive Temp Auth Compile, Web Production Build, D7 authorization y Desktop Portability; la producción posterior sigue fallando.
producción conocida: secuencia `unknown rpc_result true` -> 404 reconnect -> 404 reauthorizing -> verify timeout, ~35–36 s.

### Duplicate-check

El archivo TEMP no existía en el baseline, por lo que no había cronología acumulada que repetir. Se tomó como evidencia previa válida PR #92/#94/#95 y la secuencia runtime posterior a #95. No se repitió la hipótesis “sólo preservar tempSessionId”.

### Pregunta de este turno

**¿Qué significa exactamente el 404 en mtcute 0.31.0 y qué revela el `rpc_result ...: true` inmediatamente anterior sobre la sesión reconstruida?**

### Investigación realizada

- fijación de HEAD canónico y PRs recientes;
- comprobación de CI del HEAD/PR #95;
- determinación de versión lock exacta de mtcute;
- lectura de `SessionConnection`, `MtprotoSession` e `intermediate` del commit upstream exacto v0.31.0;
- lectura de `webTempAuth.ts`, `webTransportSession.ts`, `webTransport.worker.ts` y patch de PR #94/#95;
- trazado del bind manual, pending map, ACK queue, destroy de la conexión auxiliar y reconstrucción del cliente;
- contraste con documentación oficial de transport errors, PFS, `auth.bindTempAuthKey`, service messages e `initConnection`.

### Evidencia nueva

- mtcute upstream exacto: `11b1c8894b653139b180c13620692f298bc147fb`.
- `packages/core/src/network/transports/intermediate.ts`: 404 es frame MTProto transport de 4 bytes.
- `packages/core/src/network/session-connection.ts`: primer 404 resetea/reconecta; segundo borra auth key y reautoriza; `_resetSession` encola old sessionId para destroy antes de `resetState(true)`.
- `src/features/cloud/webTransport.worker.ts`: #95 fuerza de nuevo el old bound sessionId después de cada `resetState`, creando posible `destroy_session` contra el ID activo.
- `src/features/cloud/webTempAuth.ts`: el RPC manual cercano que devuelve exactamente Bool es `auth.bindTempAuthKey`; usa un msgId explícito y pending `{_: 'bind'}`.
- mtcute ACK del bind se encola y puede esperar hasta 30 s.
- `webTransportSession.ts`: `prepared.destroy()` ocurre inmediatamente tras retornar del bind.
- documentación MTProto: resultados RPC pendientes pueden reenviarse en reconexión; session + key identifica instancia y mantiene estado del servidor.
- PR #94: para evitar `CONNECTION_API_ID_INVALID`, Web marca `initConnectionCalled=true`; especificación oficial exige `initConnection` después de cada bind.

### Resultado

El 404 quedó clasificado y el warning anterior dejó de ser “ruido”: hay una explicación concreta de alta confianza para el Bool true como respuesta de bind reenviada a un Session nuevo que carece del request bookkeeping original. Además se descubrió un defecto independiente y concreto en el recovery de #95 que puede explicar la escalada del primer al segundo 404.

Aún NO se demostró qué campo/acción exacta origina el **primer** 404. Las dos causas líderes son la reconstrucción incompleta del Session y la supresión de `initConnection` post-bind.

### Impacto sobre hipótesis

- H1 SUBE: 55% → 78%
- H2 NUEVA: 60%
- H3 BAJA: 40% → 20%
- H4 NUEVA: 95% como defecto / 70% como causa del segundo 404
- “404 HTTP” DESCARTADA
- “tempSessionId solamente” DESCARTADA

### Qué se puede afirmar ahora

- 404 no es HTTP.
- La secuencia exacta de logs coincide con el recovery genérico de mtcute 0.31.0.
- El cliente que ve el `rpc_result true` no tiene el request correspondiente en su pending/recent map.
- Existe una ruta concreta por la que el Bool del bind queda sin ACK antes de destruir la conexión auxiliar.
- Reutilizar key + sessionId en un Session nuevo explica por qué ese resultado puede aparecer como unknown.
- #95 puede restaurar el mismo sessionId que mtcute ya marcó para destrucción después del primer 404.
- `initConnection` requerido post-bind está siendo suprimido deliberadamente.

### Qué todavía NO se puede afirmar

- Que el `req_msg_id` runtime sea 100% el msgId del bind sin correlación explícita.
- Que el primer 404 sea causado específicamente por seqNo, salt, msgId state, DC o `initConnection`.
- Que mantener el mismo objeto Connection sea obligatorio; el protocolo permite nueva conexión física para una misma sesión.
- Que DC 1 sea incorrecto.
- Que el fix correcto sea “copiar campo X”.

### Próxima pregunta recomendada

**¿Qué request exacto creó el `req_msg_id` del Bool true y cuál es el primer mensaje saliente que provoca el primer 404?**

Prioridad práctica: correlacionar `prepared.metadata.msgId` con el warning y luego separar reconstrucción de Session vs `initConnection` con un probe A/B.

### READY_FOR_IMPLEMENTATION

NO

# RESUMEN PARA LA MAÑANA

## Diagnóstico principal

Web está intentando continuar una temporary bound session en un `TelegramClient`/Session nuevo transfiriendo sólo key + DC + self + sessionId. La evidencia nueva muestra que el Session viejo todavía puede tener estado real pendiente: en particular, el `rpc_result(true)` del bind puede no haber sido ACKeado antes de destruir la conexión y reaparece en el Session reconstruido sin su pending request. El primer 404 sigue sin aislarse totalmente, pero el handoff de Session y la supresión de `initConnection` son ahora las dos causas líderes.

Además, PR #95 contiene un recovery defectuoso demostrable: después del primer 404, mtcute encola el old sessionId para `destroy_session` y genera uno nuevo; el seam vuelve a imponer oldId, dejando posible `destroy_session(oldId)` contra el propio Session reactivado.

## Confidence

78%

## Evidencia decisiva

- Exact source mtcute 0.31.0 para 404/reconnect/reset.
- Bind manual en BeatGaler devuelve Bool y usa pending msgId explícito.
- ACK del bind puede esperar 30 s.
- BeatGaler destruye la conexión auxiliar inmediatamente después del bind.
- El cliente productivo es un Session nuevo con same key/sessionId pero pending/recent maps nuevos.
- MTProto permite reenviar una respuesta RPC pendiente en una sesión reanudada.
- PR #94 suprime `initConnection` pese al requisito oficial post-bind.
- PR #95 restaura un sessionId que mtcute acaba de encolar para destrucción.

## Qué cambió durante la noche

Primer turno del TEMP. Se descartó que 404 sea HTTP, se invalidó “tempSessionId solamente”, se encontró una explicación concreta del unknown Bool y se descubrió el conflicto `queuedDestroySession` vs restore de #95.

## Hipótesis descartadas

- HTTP 404.
- WASM MIME como root cause del 404.
- Preservar únicamente tempSessionId como solución suficiente.

## Alternativas todavía posibles

- `initConnection` post-bind suprimido como causa primaria.
- DC/key mismatch.
- estado Session específico (seqNo/messageId/salt/ACK/pending) como primera causa.
- expiración/evicción temprana de temp key, actualmente de menor probabilidad.

## Fix recomendado actualmente

**Ningún fix productivo todavía.**

La dirección arquitectónica más prometedora es evitar el handoff artificial entre Session bound y Session productivo, o demostrar exactamente qué estado debe conservarse antes de decidir. No parchear “otro campo” sin probe discriminante. También deberá eliminarse el recovery de #95 que reutiliza un ID ya marcado para destroy.

## Archivos que probablemente requerirían cambio

- `src/features/cloud/webTempAuth.ts`
- `src/features/cloud/webTransportSession.ts`
- `src/features/cloud/webTransport.worker.ts`
- regresiones/harness Task 5.1 correspondientes

No cambiar todavía.

## Regression tests necesarios

- bind exitoso -> ACK confirmado -> primera RPC productiva;
- same Session vs reconstructed Session A/B;
- correlación req_msg_id bind/unknown;
- primer 404 no puede activar destroy del mismo active sessionId;
- second 404 recovery correcto para temporary key;
- `initConnection` post-bind conforme al protocolo sin filtrar secretos al browser;
- cold/warm reload y retry sin worker zombie.

## Experimento productivo de validación

Después de resolver en probe local, un único intento productivo con logging seguro debe demostrar:

- same DC esperado;
- bind req_msg_id hash conocido;
- ningún `unknown rpc_result` no explicado;
- `initConnection`/primera RPC en orden esperado;
- cero transport 404;
- `getMe`/verify exitoso;
- Library termina en ready/empty autoritativo;
- sin secretos en console.

## Problemas secundarios

- WASM MIME incorrecto.
- SSL/SNI health-check de deploy separado.
- ~35 s por intento + retry/reload potencialmente excesivo.
- logs internos browser-visible a revisar antes de alpha.

## Qué NO tocar todavía

- Plan Maestro y status oficial de Task 12.1.
- infraestructura/nginx en este turno.
- provider/credenciales permanentes.
- upload/download pools hasta resolver MAIN.
- parches especulativos de salt/seqNo/timeOffset/DC sin evidencia.

## Estado

CONTINUE_INVESTIGATION
