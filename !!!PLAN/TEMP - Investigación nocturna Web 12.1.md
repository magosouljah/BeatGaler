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
- HEAD sigue siendo merge de PR #95 y no cambió en los turnos 00:58, 01:45, 02:42 y 03:45.
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
- **NUEVO TURNO 03:45:** `SessionConnection.destroy()` de mtcute no ejecuta `destroyAuthKey()`. Hace `super.destroy()` y después `reset(true)` local. `destroyAuthKey()` es una operación separada que activa `_needDestroyAuthKey` y fuerza un flush explícito. Por tanto `prepared.destroy()` no contiene una ruta normal que invalide server-side la temporary auth key.
- **NUEVO TURNO 03:45:** en `MtprotoSession.encryptMessage()`, mtcute usa `_authKeyTemp` sólo si está ready; de lo contrario usa `_authKey`. En Session B `_authKeyTemp` está vacío y la key exportada se importó como `_authKey`, así que el primer paquete productivo se cifra con **exactamente la key importada**, no con otra ranura accidental.
- **NUEVO TURNO 03:45:** el PFS nativo mantiene la permanent key y la temp key en ranuras distintas porque necesita lifecycle/recovery, pero la posición de la key en la estructura cliente no cambia su auth_key_id criptográfico. Importar la temp key como primary es incorrecto para lifecycle, pero no demuestra por sí mismo que el primer paquete use una key distinta.
- **NUEVO TURNO 03:45:** el conjunto de divergencias con errores tipados queda más acotado: seqNo bajo -> bad_msg 32; msg_id/time -> bad_msg 16/17; salt -> bad_server_salt 48; falta de initConnection tiene recovery explícito `CONNECTION_NOT_INITED` en mtcute. Ninguna de esas rutas, aislada y correctamente decodificada, es la firma natural de un transport 404.
- WASM MIME sigue SECONDARY: fallback alcanza MAIN y procesa MTProto antes del 404.

### Hipótesis activas

#### H1 — handoff/reconstrucción incoherente de la Session bound

- confidence: **96% como defecto estructural**; **80% como causa o prerrequisito directo del primer 404**.
- descripción: bind ocurre en Session A y la primera RPC en Session B. PR #95 conserva sessionId pero no conserva estado monotónico/bookkeeping de esa misma Session.
- evidencia: A consume seqNo/messageId durante bind; B reinicia `_seqNo`, `_lastMessageId`, pending/recent/ACK state y salta el post-bind initConnection.
- matiz nuevo: los campos secuenciales aislados tienen errores MTProto específicos; el 404 probablemente ocurre en un nivel anterior o combinado de aceptación de la sesión/key/envelope, no simplemente por `_seqNo=0`.
- discriminante: mantener la misma `MtprotoSession` A para primera RPC y comparar contra B.

#### H2 — `initConnection` post-bind suprimido

- confidence: **100% como divergencia de protocolo**; **58% como causa directa del primer 404**.
- a favor: requisito oficial y upstream pone `initConnectionCalled=false` tras bind PFS.
- en contra como 404 exacto: mtcute maneja explícitamente `CONNECTION_NOT_INITED` como RPC error/retry, por lo que una omisión aislada y decodificable tiene una firma más específica que transport 404.
- discriminante: misma Session/estado, comparar initConnection real vs seam artificial.

#### H3 — DC/key mismatch, key destruida o temporary key desaparecida

- confidence: **4% para mismatch/destrucción cliente; 10% agregado incluyendo desaparición server-side**.
- contra mismatch/destrucción cliente: mismo DC en generación/bind/export; B descifra replay Bool; `destroy()` no llama `destroyAuthKey()`; outbound B usa la key importada en `_authKey`.
- todavía posible: Telegram puede olvidar temp keys o rechazar el envelope/sesión aunque auth_key_id sea correcto.
- discriminante: correlacionar hash de auth_key_id/DC del bind y del primer paquete saliente y timestamp exacto del primer 404.

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
- **`prepared.destroy()` destruye server-side la temporary auth key** — DESCARTADA para la ruta normal de mtcute 0.31.0; `destroyAuthKey()` es explícito y separado.
- **Session B puede estar cifrando accidentalmente con otra key local** — MUY IMPROBABLE; `encryptMessage()` elige `_authKey` porque `_authKeyTemp` no está ready y `_authKey` contiene la key exportada.

### Primera secuencia productiva identificada

1. Session A abre socket y genera temp key.
2. A manda `auth.bindTempAuthKey` bajo `tempSessionId`; consume estado content-related.
3. A recibe `Bool true`; ACK puede quedar pendiente.
4. `prepared.destroy()` cierra/destruye el objeto conexión y resetea estado local; no llama `destroyAuthKey()`.
5. Session B se crea desde cero e importa la misma temp key como `_authKey`.
6. PR #95 restaura sólo el `sessionId`.
7. B puede recibir replay del `Bool true`, pero no reconoce su `req_msg_id`.
8. B mantiene `_seqNo=0` y `initConnectionCalled=true` artificial.
9. Primera RPC productiva: `users.getUsers(inputUserSelf)`; `encryptMessage()` usa la key importada en `_authKey`.
10. Producción reporta después transport 404.

### Estado transferible entre conexiones — clasificación actualizada

| Estado | Clasificación | Nota |
|---|---|---|
| authKey bytes | REQUIRED | presente y usada por B |
| authKey slot `_authKey` vs `_authKeyTemp` | lifecycle REQUIRED; no cambia por sí sola key bytes/id | diseño actual rompe PFS recovery |
| tempSessionId | REQUIRED | presente por PR95 |
| `_seqNo` | REQUIRED si se conserva mismo sessionId | B lo reinicia |
| `_lastMessageId` / monotonic msg state | REQUIRED o debe iniciarse Session nueva coherente | B lo reinicia |
| pending bind request / recent outgoing | debe resolverse o continuarse coherentemente | perdido; explica unknown Bool |
| pending ACK del bind | debe flush/resolverse o continuarse | puede perderse |
| temp server salt | REQUIRED para transición limpia; bad_server_salt permite recuperación | no transferido explícitamente |
| time offset | relevante; tiene recovery propio | no transferido explícitamente |
| key temporal/PFS semantics | REQUIRED para expiry/recovery | hoy temp key se trata como primary |
| `initConnectionCalled` | debe quedar false post-bind hasta initConnection real | hoy se fuerza true |
| socket física | NOT REQUIRED | puede reemplazarse |
| server-side key destruction al cerrar A | NOT EXPECTED | `destroy()` no llama `destroyAuthKey()` |

### Mejor explicación actual del `unknown rpc_result true`

Replay del `rpc_result` del `auth.bindTempAuthKey` exitoso cuyo ACK/pending bookkeeping quedó en Session A. Confidence **92%**. Falta correlación numérica de `req_msg_id`, pero tipo Bool, orden y handoff encajan.

### Mejor explicación actual del primer 404

El primer 404 ya no se explica bien como “B eligió una key equivocada” ni como “cerrar A destruyó la key”. La evidencia apunta a que B usa la key correcta pero presenta al servidor una continuación de Session protocolariamente incoherente y sin la transición PFS/post-bind esperada.

Lo más importante del turno 03:45 es separar dos capas:

1. **Errores internos de Session decodificable** (`seqNo`, `msg_id`, salt, `initConnection`) tienen respuestas MTProto/RPC específicas.
2. **Transport 404** indica que el servidor no está aceptando el paquete en un nivel más temprano o más fundamental (key recognition / envelope / estado de temporary key / combinación de campos de la Session), aunque mtcute documenta que también puede aparecer por campos MTProto incorrectos.

Por tanto H1 sigue siendo la explicación estructural dominante, pero todavía falta una traza runtime que diga cuál es el **primer paquete saliente** asociado al 404 y si el servidor lo reconoce bajo el mismo auth_key_id.

### Próximo experimento de máximo valor

**Capturar una traza segura y mínima del primer paquete post-bind, sin cambiar comportamiento.**

Para A y B registrar únicamente metadatos no secretos:

- hash corto de auth_key_id;
- hash corto de sessionId;
- DC id;
- bind req_msg_id;
- `_seqNo` y `_lastMessageId` antes/después del bind y antes de primera RPC;
- queued ACK count;
- nombre TL del primer objeto/inner message que sale después de recibir el Bool (`msgs_ack`, `users.getUsers`, container, etc.);
- si `initConnection` está realmente presente;
- primer error/respuesta exacto y timestamp relativo.

Discriminantes:

- mismo auth_key_id + misma Session A funciona / B 404 -> H1 queda aislada.
- mismo auth_key_id + B con continuidad seqNo/salt pero sin initConnection devuelve `CONNECTION_NOT_INITED` -> H2 no era 404 directo.
- B 404 antes de cualquier RPC productiva y al enviar sólo ACK/control -> investigar envelope/session continuity antes de API wrapper.
- auth_key_id cambia entre bind y primer paquete -> revisar importación; hoy el source hace esto improbable.

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
- `regression-web-bound-temp-rpc.mjs` = asserts estáticos de source.
- hardening regression tampoco hace red.
- helper Desktop no es equivalente a Web PR95.
- live proof histórico queda NO VERIFICADO.

### Hipótesis al cierre

H1 82%; H2 72%; H3 18%.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 02:42

### Baseline / duplicate-check

Canonical sigue exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`; tree `e8e2e19f430e42852fe963645c882f475e7792a6`. Sin fix duplicado.

### Pregunta técnica única

**¿Cuál es exactamente la primera RPC productiva que sale desde Session B y qué estado concreto de Session ya es incoherente antes de enviarla?**

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

- H1 **94% defecto / 78% causa-prerrequisito primer 404**.
- H2 **100% divergencia / 62% causa directa**.
- H3 **8%**.
- H4 sin cambio.

### Qué NO puede afirmarse todavía

No está demostrado si el primer server-reject real es seqNo 32, falta de initConnection, otro campo de Session o framing/key semantics que derive en 404.

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 03:45

### Baseline / duplicate-check

Canonical sigue `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, tree `e8e2e19f430e42852fe963645c882f475e7792a6`. No apareció fix posterior ni PR duplicado relevante.

### Pregunta técnica única

**¿Qué cambio exacto entre Session A y B todavía puede explicar un transport 404, y puede descartarse que la key sea destruida o que B cifre con una key local distinta?**

### Investigación realizada

Se inspeccionó source exacto mtcute v0.31.0:

- `SessionConnection.destroy()` / `reset()` / `destroyAuthKey()`;
- `MtprotoSession.encryptMessage()` / key-slot selection;
- transición PFS `_authKeyTempSecondary -> _authKeyTemp` + `tempServerSalt`;
- manejo `CONNECTION_NOT_INITED`;
- clasificación ya confirmada de bad_msg para seqNo/msg_id/salt.

### Evidencia decisiva

1. `destroy()` no llama `destroyAuthKey()`; el borrado server-side de auth key requiere una ruta explícita distinta.
2. Por tanto cerrar `prepared` después de bind no explica normalmente que el servidor “olvide” la key por acción del cliente.
3. B cifra con `_authKey` porque `_authKeyTemp` está vacío; `_authKey` contiene exactamente la temp key exportada.
4. El replay Bool descifrado en B además demuestra que el auth_key_id importado puede reconocer tráfico del servidor asociado a esa key/session.
5. `_seqNo`, msg_id/time y salt tienen respuestas MTProto específicas si la capa cifrada se acepta; `initConnection` también tiene un error RPC explícitamente manejado.
6. En consecuencia, ninguna de esas divergencias aisladas explica limpiamente por qué el servidor responde con un transport 404. El primer 404 apunta más a la aceptación del envelope/temporary-key/session como conjunto.

### Impacto en hipótesis

- H1 sube a **96% como defecto estructural / 80% causa-prerrequisito del primer 404**.
- H2 sigue 100% divergencia, baja a **58% como causa directa del 404**.
- H3 baja a **4% para mismatch/destrucción cliente**; queda ~10% agregado si incluimos desaparición server-side.
- H4 sin cambio.

### Conclusiones invalidadas este turno

- `prepared.destroy()` destruye automáticamente la temporary auth key server-side — DESCARTADA.
- Session B probablemente elige otra key local para cifrar — MUY IMPROBABLE por source exacto.
- seqNo reset aislado basta para explicar transport 404 — NO; demuestra Session inválida, pero su error esperado decodificado es bad_msg 32.

### Próxima pregunta

¿Cuál es exactamente el primer objeto TL/paquete que sale de B después del replay Bool y antes del 404 (`msgs_ack`, `users.getUsers` o container), y conserva el mismo auth_key_id/sessionId en esa salida?

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

PR #95 corrigió una sola pieza —la identidad `sessionId`— pero el flujo sigue rompiendo la continuidad real de la Session: el bind ocurre en A; luego B reconstruye key+sessionId sin seqNo/message bookkeeping/salt/PFS lifecycle y además suprime el initConnection post-bind.

El turno 03:45 elimina dos explicaciones fáciles que podían distraer: `prepared.destroy()` no borra la auth key server-side y Session B no parece cifrar con una key local distinta. El 404 se concentra ahora en la **aceptación del envelope/session/temp-key como conjunto**, no en un simple bug de selección o destrucción de key.

### Confidence

- H1 handoff incoherente: **96% defecto estructural / 80% causa-prerrequisito primer 404**.
- H2 initConnection suprimido: **100% divergencia / 58% causa directa**.
- H3 mismatch/destrucción cliente: **4%**; incluyendo desaparición server-side: ~10%.
- H4 recovery self-destroy: **95% defecto / ~70% segundo 404**.
- unknown Bool = replay bind: **92%**.

### Evidencia nueva más importante de 03:45

`SessionConnection.destroy()` no llama `destroyAuthKey()`, y `MtprotoSession.encryptMessage()` en B usa la key importada en `_authKey`. Esto descarta que el cierre normal de A destruya la key y hace muy improbable que B esté enviando con una key diferente.

### Fix

Aún NO autorizado ni suficientemente aislado. No se modificó producto, no se abrió PR, no hubo merge ni deploy.

### Próximo paso decisivo

Observar, sin cambiar comportamiento, el primer paquete post-bind que precede al 404 y correlacionar de forma segura auth_key_id/sessionId/DC/seqNo/tipo TL. Eso separará definitivamente “handoff Session incoherente” de “temporary key no aceptada por servidor” y permitirá decidir si la corrección debe mantener la misma Session A o reconstruir una Session B completa.

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
