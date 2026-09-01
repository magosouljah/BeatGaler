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
- HEAD sigue siendo merge de PR #95; no cambió entre el turno 00:58 y el turno 01:45.
- No se encontró un fix posterior que cierre Task 12.1; no hay trabajo duplicado que deba evitarse.
- TEMP acumulativo vive en `temp-web-12.1-night-research` porque canonical exige PR y esta investigación prohíbe abrir PR.

### Hechos confirmados

- Lockfile fija `@mtcute/web`, `@mtcute/core` y `@mtcute/wasm` 0.31.0; source upstream exacto: tag `v0.31.0`, commit `11b1c8894b653139b180c13620692f298bc147fb`.
- El 404 observado es un **MTProto transport error**, no HTTP. `intermediate.ts` interpreta un frame de 4 bytes como código de transporte.
- Telegram documenta 404 principalmente como auth key no encontrada, aunque también puede aparecer por estado/campos/encapsulado MTProto incorrectos.
- La secuencia productiva coincide exactamente con `SessionConnection.handleError()` de mtcute 0.31.0: primer 404 -> reconnect/reset Session; segundo 404 -> reset auth key + reauthorization.
- Web importa la temporary key como auth key primaria con `usePfs:false`; por ello NO entra en la recuperación PFS nativa de mtcute.
- `_resetSession()` encola el sessionId viejo para `destroy_session` y luego espera que `resetState(true)` genere uno nuevo.
- PR #95 envuelve `resetState()` y vuelve a imponer el sessionId bound viejo. Esto deja el mismo ID simultáneamente como candidato a `destroy_session` y como Session activo. Es un defecto concreto posterior al primer 404.
- `webTempAuth.ts` hace `auth.bindTempAuthKey` manual sobre una `ManualSessionConnection`, con `msgId`, nonce, `tempSessionId`, temporary key y server salt.
- `auth.bindTempAuthKey` devuelve `Bool`; la respuesta se ACKea en mtcute pero el primer ACK puede permanecer en `queuedAcks` hasta 30 s si no hay otro flush.
- `webTransportSession.ts` destruye la conexión auxiliar inmediatamente después de terminar el bind. Existe una ruta real donde el bind devolvió `true` pero su ACK todavía no salió.
- El nuevo `TelegramClient` usa `MemoryStorage`/Session nuevos. Aun reusando key/DC/sessionId, no hereda el pending request ni `recentOutgoingMsgIds` del bind.
- MTProto puede reenviar un RPC result no reconocido/acknowledged. La mejor explicación de `unknown message ...: true` sigue siendo el `rpc_result` reenviado del `auth.bindTempAuthKey` exitoso. Confidence **90%**; falta correlacionar en runtime el `req_msg_id` con `prepared.metadata.msgId`.
- Telegram exige `initConnection` después de cada `auth.bindTempAuthKey`.
- PR #94 suprime deliberadamente ese `initConnection` poniendo `session.initConnectionCalled = true`, para evitar `CONNECTION_API_ID_INVALID` con `apiId:0`.
- **NUEVO TURNO 01:45:** `.github/workflows/probe-task-5.1-productive-temp-auth-compile.yml` NO es un probe MTProto runtime. Sólo ejecuta `npm run build:web` y `npm run test:typecheck`, sube logs y exige exit 0.
- **NUEVO TURNO 01:45:** `scripts/regression-web-bound-temp-rpc.mjs` tampoco hace red ni RPC. Es una regresión estática que lee source y exige patrones; entre ellos exige explícitamente `session.initConnectionCalled = true`. Por tanto no puede demostrar que Telegram acepte el seam que está validando.
- **NUEVO TURNO 01:45:** `scripts/regression-task-5.1-hardening.mjs` es también una regresión local/estática de trust boundaries, CSP/CORS, filesystem scopes y temp-auth boundary; no prueba una RPC real.
- **NUEVO TURNO 01:45:** el helper Desktop `src-tauri/direct-transport/transport-helper.source.mjs` sí contiene el flujo real de generar temp auth, bindear, crear otro `TelegramClient`, importar la key y ejecutar `getMe()`/`getChat()`. Sin embargo, ese helper NO transfiere `prepared.metadata.tempSessionId` al nuevo cliente y no instala el seam de PR #95. Por tanto no es una réplica equivalente del Web productivo actual.
- PR #94 afirma textualmente que un “historical Task 5.1 live proof” estableció que una bound temporary key podía emitir RPC productiva marcando la sesión inicializada. En el repositorio canónico inspeccionado en este turno, los artefactos con nombre Task 5.1 encontrados no constituyen esa prueba runtime. La afirmación histórica queda **NO VERIFICADA**, no descartada.
- Consecuencia: la supuesta evidencia histórica contra H2 era más débil de lo registrado. No debe tratarse como prueba de que omitir `initConnection` es aceptado por Telegram.
- WASM MIME sigue SECONDARY: el fallback alcanza MAIN y procesa MTProto antes del 404.

### Hipótesis activas

#### H1 — handoff/reconstrucción incompleta de la Session bound

- confidence: **82%** (antes 78%).
- descripción: bind ocurre en Session A y la primera RPC productiva en Session B reconstruida. Copiar key/DC/self/sessionId no equivale a continuar coherentemente toda la Session MTProto.
- a favor: dos Session distintas; ACK/pending/recent message state no transferidos; reaparece probablemente el Bool del bind; PR #95 conservó sólo ID y falló; recovery crea estado híbrido; el supuesto working probe equivalente no quedó demostrado.
- en contra: MTProto sí permite reemplazar conexión física; todavía no está identificado qué estado adicional causa específicamente el **primer** 404.
- discriminante: mismo bind, comparar primera RPC en la misma Session A vs handoff a Session B, manteniendo todo lo demás igual.

#### H2 — `initConnection` post-bind suprimido

- confidence: **72%** (antes 60%).
- descripción: Web marca artificialmente `initConnectionCalled=true` y manda la primera RPC sin el `initConnection` exigido por protocolo.
- a favor: requisito oficial explícito; seam de PR #94; los “tests” Task 5.1 inspeccionados sólo compilan o verifican source y no prueban aceptación server-side.
- en contra: PR #94 afirma que existió un live proof histórico; no se encontró todavía el artefacto/traza que permita verificar o refutar esa afirmación. Tampoco existe aún una traza que demuestre que esta omisión produce exactamente transport 404.
- discriminante: bound Session idéntica con A) `initConnection` real y válido después del bind vs B) `initConnectionCalled=true` sin envío; observar el primer mensaje y respuesta.

#### H3 — DC/key mismatch o temporary key desaparecida

- confidence: **18%** (antes 20%).
- a favor: 404 puede significar auth key not found.
- en contra: generación, bind y export usan mismo dcId; fallo es inmediato y determinista; el probable reenvío del Bool del bind sugiere continuidad suficiente de key/session para recibir tráfico.
- discriminante: correlacionar dcId y hash de auth_key_id a ambos lados sin registrar secretos.

#### H4 — recovery de PR #95 auto-destruye el sessionId restaurado

- confidence: **95% como defecto; 70% como causa del segundo 404; 0% como causa del primero**.
- descripción: tras el primer 404, mtcute encola old sessionId para destroy; wrapper lo restaura como activo.
- discriminante: instrumentar únicamente IDs/hash en queuedDestroySession y Session activa después del primer 404.

### Hipótesis / conclusiones descartadas o invalidadas

- `404 = HTTP 404` — DESCARTADA.
- `preservar únicamente tempSessionId basta` — INVALIDADA por producción posterior a PR #95.
- `WASM MIME causa el 404` — DESCARTADA como root cause actual; sigue bug secundario.
- `el workflow Task 5.1 Productive Temp Auth Compile demuestra una RPC productiva` — DESCARTADA: sólo build/typecheck.
- `regression-web-bound-temp-rpc.mjs demuestra aceptación server-side` — DESCARTADA: sólo asserts sobre texto source.
- `la afirmación histórica de live proof de PR #94 está verificada por los artefactos Task 5.1 hoy visibles` — INVALIDADA COMO EVIDENCIA; queda NO VERIFICADA hasta localizar la traza/probe runtime original.

### Diferencias working probe / artefactos históricos vs producción

| Dimensión | Artefacto histórico inspeccionado | Web productivo | Lectura actual |
|---|---|---|---|
| Workflow `probe-task-5.1-productive-temp-auth-compile.yml` | build + typecheck, sin red | RPC real falla con 404 | NO prueba runtime |
| `regression-web-bound-temp-rpc.mjs` | regex/source assertions | red real | NO prueba runtime |
| `regression-task-5.1-hardening.mjs` | checks locales/estáticos | red real | NO prueba runtime |
| Desktop helper | bind real -> otro TelegramClient -> `getMe/getChat`; no transfiere tempSessionId | bind real -> otro TelegramClient; PR95 fuerza tempSessionId | parecido, NO equivalente |
| Session que hace bind | ManualSessionConnection | ManualSessionConnection | igual en helper/Web |
| Session primera RPC | TelegramClient nuevo | TelegramClient nuevo | igual conceptualmente |
| tempSessionId transferido | Desktop helper actual: NO | Web PR95: SÍ | diferencia crítica |
| initConnection post-bind | Desktop helper no instala seam explícito aquí; comportamiento high-level depende de mtcute | Web lo suprime explícitamente | diferencia crítica |
| evidencia de éxito server-side conservada | NO localizada este turno | producción = FAIL | hueco histórico |

### Estado transferible entre conexiones

| Estado | Clasificación | Nota |
|---|---|---|
| authKey bytes | REQUIRED | identidad criptográfica |
| authKeyId separado | NOT REQUIRED | derivable de authKey |
| key temporal/PFS semantics cliente | REQUIRED | expiry/recovery correctos; Web hoy la trata como primary |
| expiry | REQUIRED | renewal |
| tempSessionId | REQUIRED según bind contract para continuar esa Session | PR95 lo conserva, insuficiente por sí solo |
| server salt | UNKNOWN | wrong salt suele tener recovery específico; no probado como 404 root |
| seqNo | UNKNOWN | reset en same session puede ser semánticamente relevante |
| message-id/time state | UNKNOWN | falta aislar; errores típicos pueden ser distintos de 404 |
| pending RPC map | UNKNOWN como transferencia; estado perdido confirmado | bind result reaparece sin mapping probable |
| pending ACKs | MUST be resolved/flush or coherently carried | bind ACK puede quedar pendiente al destruir A |
| recent outgoing IDs | UNKNOWN | explica warning classification, no probado root 404 |
| socket física | NOT REQUIRED | MTProto permite reconexión física |
| Session object/state | LEADING UNKNOWN | unidad semántica que debe probarse A/B |
| `initConnectionCalled=true` artificial | NOT protocol-required; protocol divergence | reemplaza indebidamente un `initConnection` real |
| DC | REQUIRED | debe corresponder a key |
| PFS/recovery state | REQUIRED para lifecycle correcto | actual generic primary-key recovery es incorrecto para intención |

### Mejor explicación actual del `unknown rpc_result true`

Un `rpc_result` del bind exitoso fue recibido en Session A, su ACK quedó encolado, A se destruyó, y al continuar key/sessionId en B el servidor reenvió la respuesta. B no tiene el pending/recent-outgoing original y la reporta como unknown. Confidence **90%**. Falta correlación numérica/hash de `req_msg_id`.

### Mejor explicación actual del primer 404

No hay todavía una causa única demostrada. El espacio causal se estrechó a dos variantes que pueden además interactuar:

1. **H1 (82%)**: el handoff Session A -> Session B deja una continuación incoherente de la Session bound.
2. **H2 (72%)**: la primera RPC en B viola el requisito post-bind al suprimir `initConnection`.

El turno 01:45 elimina como contrapeso fuerte la idea de que los checks Task 5.1 existentes ya hubieran probado server-side esa secuencia. PR #94 conserva una afirmación de live proof, pero el artefacto que la sustenta no fue localizado todavía.

### Relación entre `unknown true` y primer 404

Pueden compartir origen —handoff de Session incompleto— sin que el warning sea necesariamente la causa directa del 404. El warning demuestra continuidad parcial y pérdida de bookkeeping. El 404 demuestra que la siguiente continuidad/autorización no es aceptada. No afirmar causalidad directa hasta capturar orden exacto de mensajes salientes.

### Próximo experimento de máximo valor

**Probe A/B de un solo factor, con traza segura:**

- generar/bindear una temporary key una vez por caso en mismo DC;
- registrar sólo auth_key_id hash, sessionId hash, bind req_msg_id hash, queued ACK count, seqNo/lastMessageId y tipo del primer objeto MTProto; nunca key/secret;
- Caso A: después de `bind=true`, completar/flush ACK y ejecutar primera RPC sobre la misma Session que hizo el bind;
- Caso B: reproducir handoff actual a TelegramClient nuevo;
- dentro de cada caso registrar si se envía un `initConnection` real.

Lectura:
- A funciona / B 404 -> H1 aislada.
- A y B 404 cuando se suprime initConnection, pero funcionan con initConnection real -> H2 aislada.
- ambos fallan incluso con initConnection real -> volver a key/DC/binding.

Antes del probe A/B, el experimento más barato es localizar/correlacionar la supuesta traza runtime de Task 5.1 y el `req_msg_id` productivo del `Bool true`.

### Issues secundarios

- P0: recovery PR #95 puede intentar destruir el mismo sessionId restaurado.
- P1: `initConnection` post-bind está suprimido contra el protocolo.
- P1: timeout/reload ~35 s puede causar retry storm/zombie worker; pendiente auditoría específica.
- P2: WASM servido como `application/octet-stream` antes del fallback.
- P2: health-check SSL/SNI ocasionalmente observa SAN interno `ip-172-26-4-45.ec2.internal`.
- P2: consola/browser expone términos internos Telegram/MTProto/mtcute.

`READY_FOR_IMPLEMENTATION = NO`

# CRONOLOGÍA DE INVESTIGACIÓN

## TURNO 2026-09-01 00:58

### Baseline

`integration-v0.8.0-alpha.1 @ 43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`, merge PR #95. CI de #95 verde; producción posterior falla.

### Pregunta principal

¿Qué significa exactamente el 404 en mtcute 0.31.0 y qué estado se pierde al pasar del bind manual al TelegramClient productivo?

### Resultado

- 404 confirmado como MTProto transport error.
- Secuencia de recovery de mtcute coincide exactamente con producción.
- `unknown ...: true` explicado con 90% de confidence como replay del Bool de `auth.bindTempAuthKey` no ACKeado antes de destruir Session A.
- PR #95 crea un self-destroy hazard después del primer 404.
- Se confirmó divergencia: Web suprime el `initConnection` exigido después del bind.

### Hipótesis al cierre

- H1 reconstrucción incompleta: 78%.
- H2 initConnection suprimido: 60%.
- H3 DC/key mismatch: 20%.
- H4 self-destroy: 95% defecto / ~70% segundo 404.

### Próxima pregunta

¿Qué request exacto creó el `req_msg_id` del Bool true y cuál es la primera diferencia real entre el working probe Task 5.1 y Web productivo?

`READY_FOR_IMPLEMENTATION = NO`

## TURNO 2026-09-01 01:45

### Baseline / duplicate-check

Canonical sigue exactamente en `43fdf70efe6d12f47f0cd08f6eaaf6440e32f1d3`; no hubo avance de GitHub que invalide el análisis ni fix posterior de Task 12.1.

### Pregunta técnica única

**¿El “historical Task 5.1 live proof” que PR #94 usa para justificar suprimir `initConnection` realmente probó una RPC MTProto server-side equivalente al Web productivo?**

### Investigación realizada

Se inspeccionaron, sin modificar producto:

- `.github/workflows/probe-task-5.1-productive-temp-auth-compile.yml`;
- `scripts/regression-web-bound-temp-rpc.mjs`;
- `scripts/regression-task-5.1-hardening.mjs`;
- `src-tauri/direct-transport/transport-helper.source.mjs`;
- body de PR #94.

### Evidencia decisiva

1. El workflow con nombre “Productive Temp Auth Compile” sólo hace build Web y typecheck. No abre conexión MTProto ni ejecuta RPC.
2. `regression-web-bound-temp-rpc.mjs` sólo lee archivos y usa regex/asserts. Incluso exige el seam `session.initConnectionCalled = true`; por construcción no puede detectar que ese seam sea rechazado por servidor.
3. `regression-task-5.1-hardening.mjs` tampoco hace prueba de red.
4. El helper Desktop sí tiene un flujo runtime real parecido, pero el source canónico actual no copia `tempSessionId` al cliente importado y no representa exactamente PR #95.
5. PR #94 afirma que existió un live proof histórico, pero su evidencia runtime no quedó localizada en los artefactos Task 5.1 inspeccionados. Por lo tanto, para el diagnóstico actual esa afirmación debe clasificarse como **NO VERIFICADA**, no como evidencia contra H2.

### Resultado / impacto

- Se elimina una falsa sensación de cobertura: los checks existentes prueban compilación/contrato estático, no aceptación MTProto server-side.
- H1 sube 78% -> **82%** porque el supuesto precedente equivalente no está demostrado y el handoff sigue siendo la diferencia estructural fuerte.
- H2 sube 60% -> **72%** porque el principal contraargumento registrado era la supuesta prueba histórica; los artefactos encontrados no la sostienen.
- H3 baja 20% -> **18%** por comparación relativa, no por nueva prueba directa.
- H4 sin cambio.

### Qué sí puede afirmarse

Los tests/CI que pasaron alrededor de #94/#95 no podían demostrar que Telegram aceptara la secuencia bound-temp -> suppress initConnection -> RPC. Por eso CI verde y producción 404 no son contradictorios: existe un hueco de test runtime real.

### Qué NO puede afirmarse todavía

- No se puede afirmar que el live proof histórico jamás ocurrió; sólo que no quedó verificado por los artefactos inspeccionados.
- No se puede elegir todavía H1 o H2 como causa raíz única.
- No se debe implementar un fix basándose sólo en esta comparación.

### Siguiente pregunta de máximo valor

¿Puede localizarse la traza/probe runtime original de Task 5.1 y, si no, un A/B mínimo demuestra si el primer 404 desaparece al mantener la misma Session o al ejecutar el `initConnection` real post-bind?

`READY_FOR_IMPLEMENTATION = NO`

# RESUMEN PARA LA MAÑANA

### Diagnóstico actual

El problema no es HTTP, WASM ni simplemente “faltaba tempSessionId”. Web completa un bind temporal, pierde/abandona estado de Session al hacer handoff y luego manda tráfico con una Session reconstruida mientras además suprime el `initConnection` requerido. El primer 404 está concentrado entre esas dos divergencias; el recovery de PR #95 añade un segundo defecto después del primer 404.

### Confidence

- H1 handoff Session incompleto: **82%**.
- H2 initConnection post-bind suprimido: **72%**.
- H3 key/DC mismatch: **18%**.
- H4 recovery self-destroy: **95% defecto / 70% segundo 404**.
- `unknown true = replay del bind Bool`: **90%**.

### Evidencia nueva más importante de 01:45

Los artefactos Task 5.1 que parecían un precedente de “RPC productiva” no son una prueba server-side: el workflow es sólo build/typecheck y la regresión Web sólo inspecciona texto. PR #94 afirma que existió otro live proof histórico, pero aún no fue localizado. Esto aumenta materialmente la probabilidad de que el seam que suprime `initConnection` nunca haya sido validado bajo el flujo Web real.

### Cambios de conclusión

- No usar “Task 5.1 ya probó que suppress-initConnection funciona” como hecho.
- Mantenerlo como claim histórico NO VERIFICADO hasta hallar la traza real.
- H2 sube a 72%; H1 sube a 82%.

### Fix

Aún NO autorizado ni suficientemente aislado. No se modificó código, no se abrió PR, no hubo merge ni deploy.

### Archivos probablemente involucrados cuando READY sea YES

- `src/features/cloud/webTempAuth.ts`
- `src/features/cloud/webTransportSession.ts`
- `src/features/cloud/webTransport.worker.ts`
- pruebas/regresión runtime Web que hoy falta

### Regression test que falta

Un test/probe real que haga bind temporal y primera RPC contra MTProto, variando Session handoff e initConnection; los asserts de source actuales no cubren el fallo productivo.

### Validación productiva futura

Después de un fix sustentado: login -> runtime config -> bind -> primera RPC -> library browse, sin `unknown rpc_result`, sin transport 404, sin reconnect/reauthorize loop y sin verify timeout.

### No tocar todavía

No corregir a ciegas WASM MIME, SSL/SNI o copy interno como si fueran root cause del primer 404. No eliminar TEMP hasta cerrar el bloqueo.

State: `CONTINUE_INVESTIGATION`
