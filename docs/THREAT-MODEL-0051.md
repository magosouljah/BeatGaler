# THREAT-MODEL-0051 — Direct Data Plane y límites de confianza

**Estado:** DRAFT.  
**Tarea:** `!!!PLAN` Fase 0, Tarea 5.1.  
**Fecha:** 2026-08-24.

## 1. Activos que protegemos

- bot token y autorización permanente de cada transport bot;
- temporary auth keys activas;
- identidad de cuenta BeatGaler;
- mapping usuario -> vault;
- mapping lease -> bot -> vault;
- beats, artwork, samples y PROJECT ZIP;
- índice de biblioteca;
- permisos administrativos del vault;
- integridad del control plane;
- aislamiento entre usuarios.

## 2. Adversarios considerados

- usuario legítimo intentando acceder al vault de otro usuario;
- malware/proceso local intentando suplantar Galer Cloud o helper;
- JavaScript comprometido/XSS en Web;
- atacante que roba una temporary auth key;
- atacante que captura/repite solicitudes;
- cliente modificado que altera IDs, scopes u operaciones;
- abuso automatizado/rate-limit;
- transport bot compartido cuyo acceso produce blast radius excesivo;
- fallo/rate-limit durante cambios de membership o permisos administrativos.

## 3. Invariantes de seguridad

1. Los archivos viajan usuario <-> Telegram directamente.
2. Galer Cloud nunca recibe los bytes como relay del data plane.
3. El cliente no recibe el bot token, API hash ni permanent auth key en el diseño objetivo.
4. Una sesión de usuario A no puede operar sobre el vault B.
5. Una temporary auth key robada tiene vida limitada y no amplía membresía/permisos del bot.
6. Los permisos baseline son mínimos, estables y justificados por operaciones reales.
7. La seguridad no depende de grant/revoke dinámico por operación.
8. El cierre/expiry deja la sesión temporal inutilizable según política.
9. Ningún servicio localhost se considera auténtico solo por escuchar en loopback.
10. Un bot compartido entre tenants no se permite hasta demostrar aislamiento aceptable.

## 4. Amenazas y pruebas obligatorias

### TM-01 — Cross-tenant

**Ataque:** modificar `vault_id`, `chat_id`, beat owner o lease para apuntar a otra biblioteca.

**Esperado:** rechazo antes de cualquier operación mutante; ningún byte ni metadata se escribe/borra en el vault ajeno.

### TM-02 — Reutilización de temporary key robada

**Ataque:** copiar una temporary auth key desde memoria y reutilizarla desde otro proceso/dispositivo.

**Esperado:** el daño máximo queda limitado por su TTL, membresía y permisos actuales del bot; definir controles adicionales viables por sesión/dispositivo.

### TM-03 — Expiración

**Ataque:** usar una key después de `expires_at` o después de que Telegram la descarte anticipadamente.

**Esperado:** falla cerrada; BeatGaler renueva/reautentica sin fallback a bot token permanente en cliente.

### TM-04 — Renovación transparente

**Escenario:** usuario mantiene BeatGaler abierto durante horas y realiza operaciones cuando la key actual se acerca al vencimiento.

**Esperado:** siguiente key preparada por adelantado; cero prompt al usuario; cero pérdida/corrupción de operación.

### TM-05 — Operación larga cruza renovación

**Escenario:** PROJECT ZIP grande sigue transfiriéndose cuando cambia la temp key activa.

**Esperado:** política explícita: terminar con sesión en vuelo o reanudar de forma segura; nunca duplicar/corromper el asset ni caer a relay Galer.

### TM-06 — Scope/operation tampering

**Ataque:** cambiar `upload` por `delete`, cambiar beat objetivo o reutilizar una autorización del control plane para otra operación.

**Esperado:** autorización server-side ata identidad, vault y operación; el cliente no decide ownership.

### TM-07 — Baseline privilege abuse

**Ataque:** una temp key robada intenta usar `delete_messages`, `pin_messages` u otro derecho baseline contra recursos que no corresponden a la sesión.

**Esperado:** baseline contiene solo derechos funcionalmente indispensables; tenant isolation y membership reducen el alcance; cualquier derecho adicional se rechaza por diseño.

### TM-08 — Permission churn / restore bloqueado

**Escenario:** cambios administrativos frecuentes disparan rate limit y Telegram impide tanto el cambio como la restauración inmediata.

**Evidencia actual:** el probe PR #12 logró 80 cambios en una primera corrida; una segunda corrida poco después, a 250 ms, recibió `FLOOD_WAIT 533s` después de 20 cambios de esa corrida, y la restauración inmediata también recibió `FLOOD`. La actividad acumulada impide afirmar que el límite sea 20.

**Esperado:** la arquitectura principal no depende de grant/revoke dinámico por operación. Backoff y recuperación se reservan a cambios administrativos/membership que sean realmente necesarios.

### TM-09 — Escalabilidad administrativa

**Ataque/estrés:** volumen de sesiones provoca joins/leaves o acciones administrativas repetidas.

**Esperado:** uploads/downloads normales no generan permission churn; medir membership changes, aplicar backoff ante flood limits, cola por bot/vault y admission control antes de degradar aislamiento.

### TM-10 — Pin baseline

**Escenario:** BeatGaler mantiene/actualiza el índice fijado.

**Esperado:** identificar el derecho mínimo exacto para pin. Ese derecho puede permanecer en baseline si es imprescindible; no concede derechos administrativos adicionales no usados.

### TM-11 — Delete propio y cross-bot

**Escenario A:** transport bot elimina un mensaje que él mismo envió.

**Esperado A:** probar que puede hacerlo sin `can_delete_messages` cuando Telegram lo permita.

**Escenario B:** un transport bot necesita reemplazar/modificar contenido cuyo mensaje fue creado por **otro** transport bot.

**Esperado B:** probar el derecho exacto requerido. Si `can_delete_messages` es imprescindible para la operación normal cross-bot, documentarlo como baseline estable mínimo; no convertirlo en grant/revoke por operación.

### TM-12 — Bot asignado a múltiples vaults

**Ataque:** key de una sesión intenta actuar contra otro vault al que el mismo bot también pertenece.

**Esperado:** diseñar aislamiento adicional; no asumir que membership de bot equivale a tenant scope. Este caso es crítico para cualquier bot compartido.

### TM-13 — Loopback spoof

**Ataque:** proceso malicioso escucha en `127.0.0.1:4000` y devuelve health response compatible.

**Esperado:** cliente rechaza servicio sin identidad/autenticación del canal prevista por arquitectura.

### TM-14 — CORS/origin

**Ataque:** origen Web no autorizado llama API BeatGaler.

**Esperado:** CORS exact-origin; producción no acepta wildcards ni orígenes dev.

### TM-15 — CSRF

**Ataque:** página externa intenta ejecutar acción autenticada cuando Web usa cookies.

**Esperado:** política SameSite + CSRF/token/origin checking según endpoint; prueba negativa automatizada.

### TM-16 — XSS/session theft

**Ataque:** JavaScript inyectado intenta leer sesión y temporary auth key.

**Esperado:** CSP restrictiva, sesión Web no legible por JS cuando sea viable, ninguna credencial permanente de infraestructura disponible en browser. La temp key se considera robable por XSS y su blast radius debe seguir siendo aceptable.

### TM-17 — SSRF

**Ataque:** artwork/URL/import externo hace que backend acceda loopback, metadata services o red privada.

**Esperado:** allowlist/esquemas/destinos y resolución segura según superficie; pruebas a localhost y rangos privados.

### TM-18 — Rate-limit/abuse

**Ataque:** usuario válido automatiza creación de sesiones, key bindings, membership changes o acciones destructivas.

**Esperado:** límites por cuenta/instalación/bot/vault; rechazo antes de trabajo caro; observabilidad sin secretos.

### TM-19 — Logout/cleanup

**Escenario:** logout o cierre limpio.

**Esperado:** borrar temp key local de RAM; limpiar leases; política de limpieza de temp keys sin rotar/revocar bot token permanente de rutina.

### TM-20 — Logs/crash dumps

**Ataque:** recuperar secrets desde logs, telemetry, error strings o crash dumps.

**Esperado:** redacción/ausencia de bot token, permanent auth key, API hash y temp key; test de patrones sensibles.

### TM-21 — Split bind permanent-side/temp-side

**Ataque:** cliente intenta obtener la permanent auth key, API hash o material equivalente durante el bind; binder recibe una temp auth key completa o bytes de archivos innecesarios.

**Esperado:** permanent auth material nunca sale del lado controlado. El binder recibe solo metadata mínima necesaria para construir el `encrypted_message`; la temp auth key permanece en el dispositivo y el RPC `auth.bindTempAuthKey` se realiza dispositivo -> Telegram.

## 5. Matriz de privilegios a validar

| Capacidad BeatGaler | Derecho esperado | Política candidata |
|---|---|---|
| Upload normal | permiso mínimo para enviar | Baseline normal |
| Download/playback | acceso de lectura | Baseline normal |
| Edit de mensaje propio | mínimo permitido por Telegram | Baseline normal |
| Delete de mensaje propio | sin `can_delete_messages` si Telegram lo permite | Probar |
| Pin/unpin índice | mínimo derecho de pin requerido | Baseline si imprescindible |
| Delete de mensaje creado por otro transport bot | posiblemente `can_delete_messages` | Baseline si imprescindible |
| Gestionar miembros | MASTER/control plane únicamente cuando sea necesario | No transport data plane |
| Promover administradores | no usar por operación normal | Fuera de arquitectura principal |

## 6. Criterios de fallo

La arquitectura se rechaza si cualquiera de estas condiciones es necesaria:

- relay de archivos por Galer Cloud;
- bot token, API hash o permanent auth key en Web/React;
- bot token o permanent auth key persistido/expuesto en Desktop;
- permiso administrativo amplio permanente sin justificación funcional;
- seguridad dependiente de grant/revoke frecuente por operación;
- bot compartido con acceso transversal no mitigado;
- no poder probar 1.9 GB directo;
- renovación visible o pérdida de operaciones;
- confiar en localhost sin autenticación.

## 7. Evidencia requerida antes de implementación sensible

- prototipo aislado permanent-side + temp auth key client-side;
- prueba de bind real contra Telegram sin permanent credentials en cliente;
- prueba de renovación;
- prueba 1.9 GB;
- prueba de operación larga cruzando renovación;
- prueba de pin con mínimo privilegio;
- prueba de delete propio y cross-bot;
- prueba de bot compartido cross-vault;
- medición de flood/rate behavior para membership/control actions;
- Windows, macOS y Web pura;
- revisión independiente de seguridad.

Hasta completar esa evidencia, 5.1 permanece **EN PROGRESO / NO-GO**.