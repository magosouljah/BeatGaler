# MIGRATION-0051-ROLLBACK — Direct transport trust redesign

**Estado:** DRAFT.  
**Tarea:** `!!!PLAN` Fase 0, Tarea 5.1.  
**Fecha:** 2026-08-24.

## 1. Objetivo

Migrar la autenticación del data plane sin cambiar su propiedad fundamental:

```text
BeatGaler <============================> Telegram
             archivos directos
```

Galer Cloud continúa como control plane y **nunca** se convierte en relay de MP3/WAV/ZIP/artwork/samples.

## 2. Estado actual a preservar durante la migración

- Desktop Direct funciona mediante transporte local actual.
- Web actual ya transfiere directamente contra Telegram, aunque todavía recibe credenciales permanentes de infraestructura que deben retirarse.
- Offline y YouTube Desktop son capacidades protegidas.
- No se rota/revoca el bot token permanente durante pruebas normales.
- El mismo vault debe conservar su identidad y contenido.
- No se crean vaults nuevos para ocultar fallos de migración.

## 3. Estado objetivo candidato

- credencial/autorización permanente del transport bot solo en infraestructura controlada;
- cliente usa temporary authorization key MTProto;
- temporary key solo en RAM;
- renovación anticipada y transparente;
- transport bot con membership limitada por leases;
- baseline de permisos mínimo y estable: pin/delete únicamente si las pruebas demuestran que son imprescindibles;
- sin promote/demote ni grant/revoke dinámico por operación normal;
- ningún archivo cruza Galer Cloud.

## 4. Fases de migración

### M0 — Arquitectura y pruebas aisladas

No tocar transporte de producción.

Construir un prototipo aislado con credenciales/vault de prueba controlados para responder:

1. ¿Puede el dispositivo generar una temporary auth key sin recibir permanent bot auth?
2. ¿Puede el lado controlado construir el binding usando la permanent auth key y solo metadata mínima proporcionada por el dispositivo?
3. ¿Puede el dispositivo ejecutar `auth.bindTempAuthKey` directamente contra Telegram usando la temp key y el binding devuelto?
4. ¿Puede usar después esa key como identidad del bot sin recibir `bot_token` ni `telegram_api_hash`?
5. ¿Puede renovarse una key antes de expirar sin interacción del usuario?
6. ¿Puede Telegram invalidarla anticipadamente y recuperarnos correctamente?
7. ¿Puede una operación larga cruzar una renovación sin corrupción/duplicado?
8. ¿Cuál es el límite/throughput real de archivos con MTProto y puede transferirse 1.9 GB end-to-end?
9. ¿Cuál es el mínimo permiso real para pin/unpin?
10. ¿Puede borrar mensajes propios sin `can_delete_messages` y qué necesita para borrar mensajes creados por otro transport bot?
11. ¿Qué blast radius tiene una temp key cuando el bot pertenece a múltiples vaults?
12. ¿Debe prohibirse o limitarse compartir transport bots entre tenants?
13. ¿Funciona en Windows, macOS y Web pura?

**Gate M0:** ninguna modificación al transporte real antes de respuestas reproducibles.

#### M0-A — Vector de binding aislado

Primer incremento permitido: implementar y verificar con material sintético la construcción server-side del `encrypted_message` de `bindTempAuthKey` según la especificación oficial, sin red ni credenciales reales.

Debe demostrar únicamente la frontera criptográfica:

- la permanent auth key es necesaria solo en el lado binder;
- el binder puede aceptar temp auth key id, temp session id, nonce, expiry y msg_id sin recibir la temp auth key completa;
- el resultado puede devolverse al cliente para que el RPC real lo haga el cliente directamente con Telegram.

**No demuestra todavía** que Telegram acepte el bind remoto ni que las librerías BeatGaler puedan importar/usar la temporary key. Esa evidencia corresponde al siguiente probe de red.

### M1 — Abstracción sin cambio de comportamiento

Introducir una interfaz/adapter de transporte que permita comparar `legacy direct` y `ephemeral MTProto direct` sin cambiar UX ni datos.

**Gate M1:** las suites actuales demuestran que el adapter legacy reproduce exactamente Direct/Offline/YouTube existentes.

### M2 — Ephemeral Direct detrás de feature flag interno

Activar el nuevo transporte solo en cuentas/vaults de prueba.

Reglas:

- flag server-side/entitlement interno, no controlado por usuario;
- no fallback silencioso a relay Galer;
- si falla, volver al adapter legacy solo en entorno de prueba/controlado;
- registrar métricas sin secrets.

### M3 — Pruebas adversariales y de carga

Ejecutar THREAT-MODEL-0051 completo:

- cross-tenant;
- replay/expiry;
- split bind permanent-side/temp-side;
- renewal;
- long upload;
- cross-vault con bot compartido;
- minimum baseline pin/delete;
- loopback spoof;
- rate/flood behavior de membership/control actions;
- 1.9 GB;
- Windows/macOS/Web según corresponda.

### M4 — Migración gradual

Solo después de revisión de seguridad:

1. porcentaje pequeño de sesiones internas;
2. testers controlados;
3. ampliar por plataforma;
4. retirar entrega cliente del bot token/API hash solo cuando el nuevo camino esté probado.

No eliminar inmediatamente el código legacy hasta completar periodo de estabilidad y rollback.

### M5 — Retirada del camino inseguro

Cuando nuevo Direct sea estable:

- eliminar `bot_token`/API hash/permanent auth material de payloads de cliente;
- eliminar decrypt del envelope Web que reconstruye esas credenciales;
- eliminar persistencias/logs incompatibles;
- retirar discovery inseguro localhost;
- cerrar feature flag legacy;
- volver a ejecutar scanners y pruebas cross-platform.

## 5. Renovación de temporary auth keys

No fijar un TTL arbitrario todavía.

Telegram documenta que una temp key puede desaparecer antes de `expires_at`, por lo que BeatGaler debe tolerar expiración anticipada.

La implementación debe mantener una ventana de solapamiento controlada:

```text
Key A ----------- usable ----------- X
                  Key B ---- ready ---------------->
```

La key B se prepara antes del vencimiento de A. Las operaciones nuevas migran a B cuando esté confirmada.

Para operaciones en vuelo se debe elegir y probar una de estas políticas:

- la conexión/operación continúa con A hasta finalizar si Telegram lo permite; o
- la transferencia se reanuda bajo B desde un checkpoint seguro.

Está prohibido reiniciar de cero silenciosamente si eso puede crear duplicados o corrupción.

## 6. Permisos administrativos

La arquitectura principal usa **baseline mínimo estable**, no privilege leases dinámicas por operación.

Motivo: PR #12 demostró que permission churn frecuente puede provocar `FLOOD_WAIT` y bloquear incluso la restauración inmediata de derechos. El probe no establece un límite universal de operaciones; sí invalida asumir que grant/revoke frecuente es un mecanismo de seguridad confiable.

Política candidata:

- pin/unpin: baseline solo si imprescindible para INDEX;
- delete propio: probar si funciona sin `can_delete_messages`;
- delete cross-bot: si BeatGaler necesita borrar mensajes creados por otro transport bot y Telegram exige `can_delete_messages`, mantener ese derecho baseline mientras el bot esté operativo;
- no promote/demote por chunk u operación;
- MASTER sigue siendo control plane y nunca data plane.

Cualquier reapertura de permisos dinámicos requerirá evidencia nueva y una decisión explícita posterior a 5.1.

## 7. Rollback

### 7.1 Qué significa rollback seguro

Rollback significa volver temporalmente al adapter Direct anterior **sin cambiar vault, IDs, mensajes ni archivos**.

No significa:

- mover archivos por Galer Cloud;
- crear biblioteca nueva;
- copiar/reimportar contenido;
- rotar/revocar bot token por defecto;
- borrar índice remoto.

### 7.2 Condiciones que disparan rollback

- corrupción o duplicación de archivos/índice;
- fallo de 1.9 GB;
- renovación rompe operaciones;
- cross-tenant o cross-vault;
- temporary key permanece útil fuera de política;
- el split bind exige permanent credentials en cliente;
- shared-bot blast radius no puede mitigarse;
- flood limits hacen inviable membership/control plane seguro;
- regresión Direct/Offline/YouTube;
- Web requiere relay o credencial permanente para funcionar.

### 7.3 Procedimiento

1. deshabilitar feature flag de Ephemeral Direct para nuevas sesiones;
2. dejar terminar o abortar de forma segura operaciones activas según estado;
3. limpiar temporary keys locales de RAM;
4. volver al adapter legacy únicamente en cohortes controladas;
5. verificar índice y assets contra fuente de verdad antes de continuar;
6. conservar logs sanitizados y evidencia de incidente;
7. mantener `NO-GO` hasta corregir y repetir adversarial tests.

## 8. Plan de compatibilidad

Durante M1–M4:

- schema de biblioteca no cambia solo por autenticación;
- IDs de mensajes existentes siguen válidos;
- Offline cache no se invalida arbitrariamente;
- Desktop antiguo y nuevo no deben editar simultáneamente un vault sin reglas de versión compatibles;
- control plane debe saber qué transport protocol usa cada sesión.

## 9. Observabilidad necesaria

Sin registrar secrets:

- duración de temp key;
- renovaciones exitosas/fallidas;
- expiración anticipada;
- bindings exitosos/fallidos;
- bytes transferidos directamente;
- throughput/latencia;
- `FLOOD_WAIT`/rate errors;
- membership changes;
- cross-tenant denies;
- upload resume/retry;
- errores por plataforma.

## 10. Evidencia requerida antes de declarar migración aprobada

- vector M0-A reproducible;
- bind real permanent-side/temp-side sin permanent credentials en cliente;
- evidencia 1.9 GB;
- renovación sin UX visible;
- operación larga cruza renovación sin corrupción/duplicado;
- matriz final de permisos baseline;
- capacidad medida bajo concurrencia;
- suite adversarial PASS;
- CI Windows/macOS/Web afectado PASS;
- revisión independiente de seguridad;
- rollback ensayado sin pérdida de datos.

Hasta entonces, 5.1 permanece **EN PROGRESO / NO-GO**.