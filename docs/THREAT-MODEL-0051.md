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
- crash o desconexión durante una privilege lease;
- transport bot compartido cuyo acceso produce blast radius excesivo.

## 3. Invariantes de seguridad

1. Los archivos viajan usuario <-> Telegram directamente.
2. Galer Cloud nunca recibe los bytes como relay del data plane.
3. El cliente no recibe el bot token permanente en el diseño objetivo.
4. Una sesión de usuario A no puede operar sobre el vault B.
5. Una temporary auth key robada tiene vida limitada y no amplía membresía/permisos del bot.
6. Los permisos delicados permanecen apagados salvo necesidad concreta.
7. Un crash no deja privilegios elevados indefinidamente.
8. El cierre/expiry deja la sesión temporal inutilizable según política.
9. Ningún servicio localhost se considera auténtico solo por escuchar en loopback.

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

**Escenario:** PROJECT ZIP grande sigue transfiriéndose cuando rota la temp key.

**Esperado:** política explícita: terminar con sesión en vuelo o reanudar de forma segura; nunca duplicar/corromper el asset ni caer a relay Galer.

### TM-06 — Scope/operation tampering

**Ataque:** cambiar `upload` por `delete`, cambiar beat objetivo o reutilizar una autorización del control plane para otra operación.

**Esperado:** autorización server-side ata identidad, vault y operación; el cliente no decide ownership.

### TM-07 — Permission escalation

**Ataque:** solicitar `can_delete_messages`, `can_promote_members` u otro permiso administrativo sin necesidad real.

**Esperado:** deny-by-default. Solo se concede el permiso exacto requerido por una operación autorizada.

### TM-08 — Crash después de elevar permisos

**Escenario:** MASTER concede un permiso delicado y cliente/backend falla antes de retirarlo.

**Esperado:** watchdog detecta privilege lease vencida y revierte el permiso de forma idempotente.

### TM-09 — Permission churn / escalabilidad

**Ataque/estrés:** gran volumen de acciones provoca promote/demote repetidos.

**Esperado:** uploads/downloads normales no generan elevaciones; backoff ante flood limits; cola por bot/vault; métricas y admission control antes de degradar aislamiento.

### TM-10 — Pin baseline

**Escenario:** BeatGaler mantiene/actualiza el índice fijado.

**Esperado:** identificar el derecho mínimo exacto para pin. Ese derecho puede permanecer en baseline si es imprescindible; no concede derechos administrativos adicionales no usados.

### TM-11 — Delete propio

**Escenario:** transport bot elimina un mensaje que él mismo envió.

**Esperado:** probar que puede hacerlo sin `can_delete_messages`. Telegram Bot API documenta que bots pueden borrar outgoing messages en groups/supergroups. Si MTProto usado por BeatGaler difiere en la práctica, documentar y justificar la elevación mínima.

Referencia: https://core.telegram.org/bots/api#deletemessage

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

**Ataque:** JavaScript inyectado intenta leer sesión y credenciales.

**Esperado:** CSP restrictiva, sesión no legible por JS cuando sea viable, ninguna credencial permanente de infraestructura disponible en browser.

### TM-17 — SSRF

**Ataque:** artwork/URL/import externo hace que backend acceda loopback, metadata services o red privada.

**Esperado:** allowlist/esquemas/destinos y resolución segura según superficie; pruebas a localhost y rangos privados.

### TM-18 — Rate-limit/abuse

**Ataque:** usuario válido automatiza creación de sesiones, key bindings, privilege leases o acciones destructivas.

**Esperado:** límites por cuenta/instalación/bot/vault; rechazo antes de trabajo caro; observabilidad sin secretos.

### TM-19 — Logout/cleanup

**Escenario:** logout o cierre limpio.

**Esperado:** borrar key local de RAM; limpiar leases; retirar privilegios temporales; política de `auth.dropTempAuthKeys` sin rotar bot token permanente de rutina.

### TM-20 — Logs/crash dumps

**Ataque:** recuperar secrets desde logs, telemetry, error strings o crash dumps.

**Esperado:** redacción/ausencia de bot token, permanent auth key y temp key; test de patrones sensibles.

## 5. Matriz de privilegios a validar

| Capacidad BeatGaler | Derecho esperado | Elevación temporal |
|---|---|---|
| Upload normal | permiso mínimo para enviar | No |
| Download/playback | acceso de lectura | No |
| Edit de mensaje propio | mínimo permitido por Telegram | No, si posible |
| Delete de mensaje propio | sin `can_delete_messages` según Bot API | No, sujeto a prueba MTProto |
| Pin/unpin índice | mínimo derecho de pin requerido | Baseline si imprescindible |
| Delete de mensaje no propio | `can_delete_messages` | Sí, solo si existe caso legítimo |
| Gestionar miembros | derecho específico | Sí |
| Promover administradores | normalmente no permitido a transport bot | Sí solo con diseño explícito / preferir MASTER |

## 6. Criterios de fallo

La arquitectura se rechaza si cualquiera de estas condiciones es necesaria:

- relay de archivos por Galer Cloud;
- bot token permanente en Web/React;
- bot token permanente persistido en Desktop;
- permiso administrativo amplio permanente sin justificación;
- bot compartido con acceso transversal no mitigado;
- no poder probar 1.9 GB directo;
- renovación visible o pérdida de operaciones;
- dependencia en cambios admin a una frecuencia no escalable;
- confiar en localhost sin autenticación.

## 7. Evidencia requerida antes de implementación sensible

- prototipo aislado de bot + temp auth key;
- prueba de renovación;
- prueba 1.9 GB;
- prueba de pin con mínimo privilegio;
- prueba de delete propio;
- prueba de crash/watchdog de privilege lease;
- prueba de bot compartido cross-vault;
- medición de flood/rate behavior;
- revisión independiente de seguridad.
