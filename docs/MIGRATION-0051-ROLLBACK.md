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
- baseline de permisos mínimo, incluyendo únicamente pin si es realmente imprescindible;
- privilegios delicados elevados mediante privilege lease corta y watchdog;
- ningún archivo cruza Galer Cloud.

## 4. Fases de migración

### M0 — Arquitectura y pruebas aisladas

No tocar transporte de producción.

Construir un prototipo aislado con bot/vault de prueba para responder:

1. ¿Puede un bot usar correctamente `auth.bindTempAuthKey` con nuestra stack?
2. ¿Puede renovarse una key antes de expirar sin interacción del usuario?
3. ¿Puede Telegram invalidarla anticipadamente y recuperarnos correctamente?
4. ¿Cuál es el límite/throughput real de archivos con MTProto?
5. ¿Puede transferirse 1.9 GB end-to-end?
6. ¿Qué pasa si una operación cruza una renovación?
7. ¿Cuál es el mínimo permiso real para pin/unpin?
8. ¿Puede borrar mensajes propios sin permiso admin delicado?
9. ¿Qué frecuencia de membership/permission changes tolera la operación segura?

**Gate M0:** ninguna modificación al transporte real antes de respuestas reproducibles.

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
- renewal;
- long upload;
- cross-vault con bot compartido;
- permission leases/crash;
- loopback spoof;
- rate/flood behavior;
- 1.9 GB;
- Windows/macOS/Web según corresponda.

### M4 — Migración gradual

Solo después de revisión de seguridad:

1. porcentaje pequeño de sesiones internas;
2. testers controlados;
3. ampliar por plataforma;
4. retirar entrega cliente del bot token solo cuando el nuevo camino esté probado.

No eliminar inmediatamente el código legacy hasta completar periodo de estabilidad y rollback.

### M5 — Retirada del camino inseguro

Cuando nuevo Direct sea estable:

- eliminar `bot_token`/API credentials de payloads de cliente;
- eliminar decrypt del envelope Web que reconstruye esas credenciales;
- eliminar persistencias/logs incompatibles;
- retirar discovery inseguro localhost;
- cerrar feature flag legacy;
- volver a ejecutar scanners y pruebas cross-platform.

## 5. Renovación de temporary auth keys

No fijar un TTL arbitrario todavía.

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

## 6. Privilege leases

Cuando un derecho delicado sea indispensable:

```text
AUTHORIZED
 -> GRANT exact permission
 -> perform operation
 -> verify
 -> REVOKE exact permission
```

Cada lease incluye al menos:

- bot;
- vault;
- operación;
- permiso;
- created_at;
- expires_at;
- estado;
- identificador idempotente.

Watchdog:

- revisa leases vencidas;
- revierte permisos pendientes;
- tolera reintentos;
- no necesita que el cliente siga conectado.

Para escalabilidad, no crear privilege lease si la operación funciona con baseline normal.

## 7. Rollback

### 7.1 Qué significa rollback seguro

Rollback significa volver temporalmente al adapter Direct anterior **sin cambiar vault, IDs, mensajes ni archivos**.

No significa:

- mover archivos por Galer Cloud;
- crear biblioteca nueva;
- copiar/reimportar contenido;
- rotar bot token por defecto;
- borrar índice remoto.

### 7.2 Condiciones que disparan rollback

- corrupción o duplicación de archivos/índice;
- fallo de 1.9 GB;
- renovación rompe operaciones;
- cross-tenant o cross-vault;
- temporary key permanece útil fuera de política;
- privilege lease deja permisos abiertos;
- flood limits hacen el diseño no escalable;
- regresión Direct/Offline/YouTube;
- Web requiere relay o credencial permanente para funcionar.

### 7.3 Procedimiento

1. deshabilitar feature flag de Ephemeral Direct para nuevas sesiones;
2. impedir nuevas privilege leases;
3. watchdog limpia leases abiertas;
4. dejar terminar o abortar de forma segura operaciones activas según estado;
5. limpiar temp keys locales;
6. volver al adapter legacy únicamente en cohortes controladas;
7. verificar índice y assets contra fuente de verdad antes de continuar;
8. conservar logs sanitizados y evidencia de incidente;
9. mantener `NO-GO` hasta corregir y repetir adversarial tests.

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
- bytes transferidos directamente;
- throughput/latencia;
- FLOOD_WAIT/rate errors;
- permission grants/revokes;
- leases recuperadas por watchdog;
- cross-tenant denies;
- upload resume/retry;
- errores por plataforma.

## 10. Evidencia requerida antes de declarar migración aprobada

- resultado del prototipo MTProto bot;
- evidencia 1.9 GB;
- renovación sin UX visible;
- matriz final de permisos;
- capacidad medida bajo concurrencia;
- suite adversarial PASS;
- CI Windows/macOS/Web afectado PASS;
- revisión independiente de seguridad;
- rollback ensayado sin pérdida de datos.
