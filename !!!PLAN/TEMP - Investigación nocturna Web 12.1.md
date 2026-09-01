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
- HEAD sigue siendo merge de PR #95 y no cambió en los turnos 00:58, 01:45, 02:42, 03:45 y 04:43.
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
- **TURNO 03:45:** `SessionConnection.destroy()` de mtcute no ejecuta `destroyAuthKey()`. Hace `super.destroy()` y después `reset(true)` local. `destroyAuthKey()` es una operación separada que activa `_needDestroyAuthKey` y fuerza un flush explícito. Por tanto `prepared.destroy()` no contiene una ruta normal que invalide server-side la temporary auth key.
- **TURNO 03:45:** en `MtprotoSession.encryptMessage()`, mtcute usa `_authKeyTemp` sólo si está ready; de lo contrario usa `_authKey`. En Session B `_authKeyTemp` está vacío y la key exportada se importó como `_authKey`, así que el primer paquete productivo se cifra con **exactamente la key importada**, no con otra ranura accidental.
- **TURNO 03:45:** el PFS nativo mantiene la permanent key y la temp key en ranuras distintas porque necesita lifecycle/recovery, pero la posición de la key en la estructura cliente no cambia su auth_key_id criptográfico. Importar la temp key como primary es incorrecto para lifecycle, pero no demuestra por sí mismo que el primer paquete use una key distinta.
- **TURNO 03:45:** el conjunto de divergencias con errores tipados queda más acotado: seqNo bajo -> bad_msg 32; msg_id/time -> bad_msg 16/17; salt -> bad_server_salt 48; falta de initConnection tiene recovery explícito `CONNECTION_NOT_INITED` en mtcute. Ninguna de esas rutas, aislada y correctamente decodificada, es la firma natural de un transport 404.
- **NUEVO TURNO 04:43:** Telegram documenta que `(auth_key_id, session_id)` identifica una Session con espacio propio de message IDs, seqNo, salt y acknowledgements. Con PFS, para abrir una Session concurrente nueva no basta cambiar `session_id`: el cliente debe generar y bindear una **temporary auth key nueva**; cada Session PFS usa su propia temp key.
- **NUEVO TURNO 04:43:** `auth.bindTempAuthKey` define `temp_session_id` como el Session ID usado para invocar el bind. Esto confirma que la temp key generada por BeatGaler no es un credential genérico reutilizable libremente entre Sessions; la bind está ligada a la Session que la invoca.
- **NUEVO TURNO 04:43:** el upstream mtcute 0.31.0 confirma la misma semántica: genera temp key, envía bind con `tempSessionId: this._session._sessionId`, espera Bool, y después **no crea ni resetea Session**. En la misma `MtprotoSession`, promueve la key temporal, instala `tempServerSalt`, conserva counters/bookkeeping existentes y únicamente fuerza `initConnectionCalled=false`.
- **NUEVO TURNO 04:43:** por tanto PR #95 acertó en que no podía inventar un sessionId nuevo para reutilizar esa temp key, pero su solución es incompleta: restaurar el ID viejo sobre un `MtprotoSession` recién creado fabrica una “continuación” cuyo identificador dice Session A mientras sus counters/ACK/salt/bookkeeping dicen Session nueva.
- WASM MIME sigue SECONDARY: fallback alcanza MAIN y procesa MTProto antes del 404.

### Hipótesis activas

#### H1 — handoff/reconstrucción incoherente de la Session bound

- confidence: **99% como defecto estructural**; **87% como causa o prerrequisito directo del primer 404**.
- descripción: bind ocurre en Session A y la primera RPC en Session B. La temp key PFS es session-scoped: no puede tratarse como una auth key genérica para una Session nueva. PR #95 mantiene el `sessionId` correcto pero lo monta sobre estado nuevo, creando una continuación internamente contradictoria.
- evidencia: Telegram define estado por `(auth_key_id, session_id)` y exige nueva temp key para nueva Session PFS; upstream mantiene la misma `MtprotoSession` tras bind; BeatGaler reinicia `_seqNo`, `_lastMessageId`, pending/recent/ACK/salt/lifecycle y sólo restaura `_sessionId`.
- matiz: todavía no está demostrado cuál de esos componentes produce exactamente el primer transport 404; algunos campos aislados tendrían errores MTProto más específicos.
- discriminante: primera RPC ejecutada en la misma `MtprotoSession` A vs handoff B.

#### H2 — `initConnection` post-bind suprimido

- confidence: **100% como divergencia de protocolo**; **55% como causa directa del primer 404**.
- a favor: requisito oficial y upstream pone `initConnectionCalled=false` tras bind PFS.
- en contra como 404 exacto: mtcute maneja explícitamente `CONNECTION_NOT_INITED` como RPC error/retry, por lo que una omisión aislada y decodificable tiene firma más específica que transport 404.
- discriminante: misma Session/estado, comparar initConnection real vs seam artificial.

#### H3 — DC/key mismatch, key destruida o temporary key desaparecida

- confidence: **3% para mismatch/destrucción cliente; 8% agregado incluyendo desaparición server-side**.
- contra mismatch/destrucción cliente: mismo DC en generación/bind/export; B descifra replay Bool; `destroy()` no llama `destroyAuthKey()`; outbound B usa la key importada en `_authKey`.
- todavía posible: Telegram puede olvidar temp keys antes de expiry, pero la reproducibilidad inmediata y la continuidad parcial lo hacen menos probable.
- discriminante: correlacionar auth_key_id/DC y timestamp exacto del primer 404.

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
- **NUEVO:** `una temporary auth key bound puede reutilizarse como auth key genérica en cualquier Session nueva del mismo DC` — INVALIDADA por documentación PFS: cada Session PFS tiene su propia temporary auth key.
- **NUEVO:** `si se conserva el mismo sessionId, una MtprotoSession recién creada equivale protocolariamente a continuar la Session anterior` — INVALIDADA; el estado server-side de esa pareja incluye msg IDs, seqNo, salts y ACK state.

### Primera secuencia productiva identificada

1. Session A abre socket y genera temp key.
2. A manda `auth.bindTempAuthKey` bajo `tempSessionId`; consume estado content-related.
3. A recibe `Bool true`; ACK puede quedar pendiente.
4. Upstream correcto seguiría usando esa misma `MtprotoSession` A, promovería la temp key, instalaría temp salt y forzaría initConnection real.
5. BeatGaler, en cambio, destruye A localmente y crea Session B desde cero.
6. B importa la misma temp key como `_authKey`.
7. PR #95 restaura el `sessionId` de A sobre B, pero no el resto de estado de A.
8. B puede recibir replay del `Bool true`, pero no reconoce su `req_msg_id`.
9. B mantiene `_seqNo=0`, `_lastMessageId` nuevo, ACK/pending/recent state vacío, salt/lifecycle reconstruido y `initConnectionCalled=true` artificial.
10. Primera RPC productiva: `users.getUsers(inputUserSelf)`.
11. Producción reporta después transport 404.

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

La evidencia ya permite afirmar con alta confianza que el modelo de handoff actual es protocolariamente incorrecto: BeatGaler conserva el identificador de la Session PFS bound, pero reemplaza el objeto Session y reinicia casi todo el estado que el servidor asocia a esa pareja `(auth_key_id, session_id)`.

Esto estrecha el 404 a una contradicción concreta: **B se presenta como continuación de A porque usa la misma temp key + mismo sessionId, pero genera el siguiente envelope como una Session recién nacida.** Telegram no contempla reutilizar esa temp key creando una Session PFS distinta; si se quiere una Session nueva debe tener una temp key nueva y su propio bind.

Aun así, no debe implementarse todavía porque falta decidir con una prueba runtime si la reparación correcta es:

1. mantener la misma `MtprotoSession`/Connection lógica después del bind y convertirla en productiva; o
2. serializar/restaurar de forma completa el estado de A antes del primer RPC.

La opción 1 coincide con el lifecycle upstream y actualmente es la candidata arquitectónica más fuerte, pero todavía no se ha probado live en el flujo Web real.

### Próximo experimento de máximo valor

**A/B de continuidad lógica, una sola variable:**

- A: bind manual y primera `users.getUsers(inputUserSelf)` en la **misma `MtprotoSession`** que hizo el bind, tras promover temp key/salt y ejecutar el post-bind initConnection apropiado.
- B: flujo actual, creando nueva `MtprotoSession` y restaurando sólo datos exportados.

Registrar sólo metadatos no secretos:

- auth_key_id hash;
- sessionId hash;
- DC;
- bind req_msg_id;
- seqNo/lastMessageId;
- queued ACKs;
- primer TL outbound;
- presencia de initConnection;
- respuesta/error exacto.

Discriminantes:

- A funciona y B 404 -> H1 queda causalmente aislada y `READY_FOR_IMPLEMENTATION` puede pasar a YES para eliminar el handoff incompleto.
- A también 404 -> revisar bind/key/DC/initConnection antes de tocar arquitectura.
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

## TURNO 2026-09-01 04:43

### Baseline / duplicate-check

Canonical sigue exactamente `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, tree `e8e2e19f430e42852fe963645c882f475e7792a6`. El único PR abierto detectado contra la rama es #93 y corresponde a un harness Windows F4/25.1, no a Task 12.1. Sin fix duplicado.

### Pregunta técnica única

**¿La temporary auth key bound puede continuar en una `MtprotoSession` nueva, o el protocolo exige conservar la misma Session lógica que ejecutó `auth.bindTempAuthKey`?**

### Investigación realizada

Se contrastó documentación oficial de Telegram PFS / data centers / bind con el source exacto mtcute v0.31.0 de `_authorizePfs()` y `MtprotoSession`.

### Evidencia decisiva

1. Telegram define cada Session por la pareja `(auth_key_id, session_id)` y le asigna su propio espacio de message IDs, seqNo, salts y acknowledgements.
2. Sin PFS se puede abrir otra Session reutilizando auth key con otro sessionId; **con PFS no**: para una nueva Session concurrente se debe generar una nueva temporary auth key.
3. La documentación PFS dice explícitamente que cada Session genera y bindea su propia temp key.
4. `bind_auth_key_inner.temp_session_id` es el Session ID usado para invocar `auth.bindTempAuthKey`.
5. Upstream mtcute implementa exactamente esa semántica: bind en `this._session._sessionId`, y tras Bool exitoso conserva la misma `MtprotoSession`; promueve temp key, instala temp salt y fuerza `initConnectionCalled=false`. No resetea `_seqNo`, `_lastMessageId`, ACKs ni pending/recent state.
6. BeatGaler hace lo contrario: destruye A, crea B desde cero y restaura sólo el ID de A. Por eso B dice ser la Session bound aunque su estado interno sea de Session nueva.

### Resultado

H1 deja de ser una hipótesis genérica de “quizá falta estado” y pasa a una incompatibilidad concreta con el modelo PFS: **la temp key es session-scoped y el handoff actual no conserva la Session lógica que la bindió**.

PR #95 corrigió sólo la identidad externa de la Session, pero no su continuidad protocolaria.

### Impacto en hipótesis

- H1: **99% defecto estructural / 87% causa-prerrequisito primer 404**.
- H2: 100% divergencia / **55% causa directa**.
- H3: **3% mismatch/destrucción cliente; 8% incluyendo desaparición server-side**.
- H4: sin cambio.

### Conclusiones invalidadas este turno

- “La temp key se puede reutilizar como key genérica en una Session nueva si el DC es el mismo” — INVALIDADA.
- “Restaurar el mismo sessionId sobre una MtprotoSession nueva equivale a reanudar la Session bound” — INVALIDADA.
- “PR95 resolvió la parte de Session y queda sólo un campo auxiliar” — INVALIDADA; resolvió sólo el identificador.

### Qué NO puede afirmarse todavía

Todavía no está causalmente probado qué campo del envelope provoca el **primer** 404 concreto ni si una corrección que mantenga A también necesita resolver simultáneamente el initConnection post-bind con credenciales válidas.

### Próximo experimento

A/B runtime mínimo: misma Session A para bind + primera RPC vs reconstrucción B actual, manteniendo todo lo demás igual. Si A funciona y B falla, H1 queda causalmente aislada y puede declararse READY_FOR_IMPLEMENTATION.

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

La evidencia ahora es más específica: el problema no es simplemente que PR #95 “olvidó unos campos”. El modelo actual viola la continuidad PFS de la Session.

Telegram trata `(auth_key_id, session_id)` como una Session con estado propio. Bajo PFS, una Session nueva necesita su propia temporary auth key y su propio bind. La temp key que BeatGaler genera y bindea pertenece a la Session A que hizo `auth.bindTempAuthKey`.

Upstream mtcute conserva esa misma `MtprotoSession` después del bind. BeatGaler destruye A, crea B y luego restaura sólo el sessionId de A. B se presenta como la Session bound pero con seqNo/msgId/ACK/salt/bookkeeping reiniciados. Esa contradicción es ahora la explicación estructural dominante del fallo.

### Confidence

- H1 handoff incoherente / temp key session-scoped: **99% defecto estructural / 87% causa-prerrequisito primer 404**.
- H2 initConnection suprimido: **100% divergencia / 55% causa directa**.
- H3 mismatch/destrucción cliente: **3%**; incluyendo desaparición server-side: ~8%.
- H4 recovery self-destroy: **95% defecto / ~70% segundo 404**.
- unknown Bool = replay bind: **92%**.

### Evidencia nueva más importante de 04:43

Telegram documenta explícitamente que, con PFS, cada Session usa su propia temporary auth key. El upstream mtcute confirma la implementación esperada: después del bind mantiene la misma `MtprotoSession`; no recrea Session ni restaura sólo el ID.

Esto invalida la idea de que PR #95 haya reconstruido una Session válida sólo por conservar `tempSessionId`.

### Fix

Aún NO autorizado: todavía falta un A/B runtime real que confirme que mantener la misma Session A elimina el primer 404 y determine si `initConnection` debe corregirse en el mismo cambio.

No se modificó producto, no se abrió PR, no hubo merge ni deploy.

### Próximo paso decisivo

Ejecutar un probe runtime de una sola variable:

- flujo A: bind y primera RPC en la misma `MtprotoSession`;
- flujo B: handoff actual a Session nueva restaurando IDs.

Si A funciona y B falla, el fix queda suficientemente aislado para implementación.

### Archivos probablemente involucrados cuando READY sea YES

- `src/features/cloud/webTempAuth.ts`
- `src/features/cloud/webTransportSession.ts`
- `src/features/cloud/webTransport.worker.ts`
- nueva regresión/probe runtime real de bound temp auth

### Validación futura mínima

bind -> misma Session lógica -> initConnection post-bind válido -> `getMe` correcto -> `getChat`/library browse, sin unknown bind replay, sin bad_msg, sin transport 404 y sin reconnect/reauthorize loop.

### No tocar todavía

WASM MIME, SSL/SNI y términos internos son secundarios. No eliminar TEMP hasta cerrar el bloqueo.

State: `CONTINUE_INVESTIGATION`