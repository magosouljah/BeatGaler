# ADR-0051 — Límites de confianza y Direct Data Plane

**Estado:** DRAFT — requiere revisión independiente de seguridad antes de aprobarse.  
**Tarea:** `!!!PLAN` Fase 0, Tarea 5.1.  
**Fecha:** 2026-08-24.  

## 1. Decisión principal

BeatGaler conservará como restricción arquitectónica obligatoria un **data plane directo entre el dispositivo del usuario y Telegram**.

Los bytes de MP3, WAV, artwork, samples y PROJECT ZIP **no deben pasar por Galer Cloud, un VPS de Galer, un worker de Galer ni otro relay controlado por Galer** durante upload o download.

```text
CONTROL PLANE
BeatGaler -> Galer Cloud
            auth / sesión / asignación / leases / políticas

DATA PLANE
BeatGaler <============================> Telegram
             archivos directos
```

Galer Cloud puede autenticar, autorizar, asignar transport bots/vaults, mantener leases y ejecutar operaciones de control. No se convierte en relay del contenido.

## 2. Problema actual

El diseño actual expone credenciales de infraestructura al cliente:

- Desktop recibe `bot_token`, `telegram_api_id` y `telegram_api_hash` dentro de la sesión Direct y el helper local consume el token.
- Web recibe esas mismas credenciales dentro de un envelope cifrado, pero el navegador las descifra; por tanto terminan en memoria del cliente.
- Cifrar el transporte no cambia el límite de confianza: quien controla el cliente puede recuperar una credencial que el cliente necesita usar.

Esto contradice el gate de seguridad que exige reducir la exposición de credenciales compartidas.

## 3. Restricciones no negociables

1. **Direct obligatorio:** archivos usuario <-> Telegram; nunca usuario -> Galer -> Telegram.
2. **Web pura:** Web no dependerá de Tauri, Desktop ni helper local.
3. **No rotación/revocación rutinaria del bot token durante sesiones normales.** La rotación del token permanente queda reservada a compromiso real u operación de seguridad expresamente diseñada.
4. **No pérdida de capacidades:** Direct, Offline y YouTube Desktop no se rompen por esta migración.
5. **1.9 GB:** ningún transporte nuevo se aprueba hasta probar end-to-end el tamaño máximo objetivo de PROJECT ZIP.
6. **Blast radius mínimo:** una credencial o sesión robada no debe otorgar acceso transversal a bibliotecas no asignadas.

## 4. Arquitectura candidata: Telegram Ephemeral Direct

La opción preferida para validación es sustituir el uso cliente del `bot_token` permanente por **temporary authorization keys de MTProto** ligadas a una autorización permanente del transport bot.

Telegram documenta que:

- una temporary auth key puede tener `expires_at`;
- puede mantenerse solo en RAM;
- una nueva key puede generarse por adelantado antes de que expire la anterior;
- `auth.bindTempAuthKey` puede ser utilizado por bots;
- `auth.dropTempAuthKeys` puede eliminar temporary auth keys de bots.

Referencias oficiales:

- https://core.telegram.org/api/pfs
- https://core.telegram.org/method/auth.bindTempAuthKey
- https://core.telegram.org/method/auth.dropTempAuthKeys
- https://core.telegram.org/mtproto/auth_key

### 4.1 Flujo propuesto

```text
1. Galer Cloud mantiene la autorización permanente del transport bot.
2. BeatGaler obtiene/genera una temporary auth key contra Telegram.
3. La temporary key se liga a la autorización permanente mediante el protocolo MTProto.
4. BeatGaler conserva la temporary key únicamente en RAM.
5. BeatGaler transfiere archivos directamente a/desde Telegram usando MTProto.
6. Antes de expirar, se prepara silenciosamente una nueva temporary key.
7. Al salir o limpiar una sesión, se descarta la key local y se limpian temporary keys según política.
```

### 4.2 Renovación transparente

La expiración no debe interrumpir al usuario.

Ejemplo conceptual:

```text
T0      Key A activa
T0+N    Key B se crea y liga antes del vencimiento
T0+N+1  nuevas operaciones usan Key B
T0+N+2  Key A deja de usarse y desaparece de RAM
```

Debe existir margen suficiente para terminar operaciones en vuelo o reanudarlas sin corrupción. El TTL final no se fija en este ADR hasta medir latencia, uploads largos, reconexión y comportamiento de Telegram.

## 5. Defensa adicional: membresía y permisos mínimos

Las temporary auth keys limitan **cuánto tiempo** una sesión robada puede ser útil, pero no crean por sí solas scopes por vault u operación. Por eso deben combinarse con aislamiento por bot/vault y mínimo privilegio.

### 5.1 Membresía

Un transport bot solo debe estar presente en los vaults que le correspondan según las leases activas. El allocator conserva la regla de reparto justo por carga.

### 5.2 Permisos base

El bot mantiene de forma estable únicamente los permisos realmente necesarios para las operaciones normales. BeatGaler necesita pin/index management, por lo que el permiso requerido para pin se considera parte del baseline si las pruebas confirman que no existe una alternativa con menos privilegio.

No se concederán derechos administrativos no utilizados.

### 5.3 Permisos delicados temporales

Los permisos de alto impacto se elevan solo si una operación real de BeatGaler los necesita.

Ejemplos a evaluar:

- borrar mensajes ajenos: `can_delete_messages`;
- gestionar miembros;
- promover administradores;
- cambiar información del chat;
- otros derechos administrativos no indispensables.

Importante: Telegram Bot API documenta que **los bots pueden borrar sus propios mensajes salientes en grupos y supergrupos sin `can_delete_messages`**. Por tanto, el flujo normal de borrar un beat enviado por el mismo transport bot no debe elevar permisos si esta propiedad se confirma también en el transporte MTProto elegido.

Referencia: https://core.telegram.org/bots/api#deletemessage

### 5.4 Privilege lease

Si una operación sí necesita elevación:

```text
Galer valida usuario + vault + operación
        -> crea privilege lease corta
        -> MASTER concede derecho mínimo
        -> se ejecuta operación directa en Telegram
        -> se confirma resultado
        -> MASTER retira derecho
```

Debe existir watchdog server-side para retirar permisos aunque el cliente se cierre o falle después de la elevación.

No se cambiarán permisos por cada chunk ni se promoverá/degradará por operación cuando Telegram no lo requiera. Esto evita convertir a MASTER en cuello de botella y reduce riesgo de flood limits.

## 6. Escalabilidad

La seguridad no puede depender de cambios administrativos excesivamente frecuentes.

Reglas:

- no permission churn por chunk;
- no elevate/demote para uploads/downloads normales si no es técnicamente necesario;
- agrupar/serializar operaciones administrativas por bot+vault;
- privilege leases idempotentes;
- backoff explícito ante `FLOOD_WAIT`/rate limits;
- métricas de promociones, degradaciones, joins/leaves y temporary-key rotations;
- admission control si la capacidad segura del pool se agota;
- nunca ampliar blast radius solo para aumentar throughput.

Telegram no publica una cifra universal que garantice una frecuencia segura para todos los cambios administrativos; la capacidad debe medirse adversarialmente antes de producción.

## 7. Separación Desktop / Web

### Desktop

La temporary auth key debe vivir únicamente en el runtime nativo, no en React, localStorage, SQLite, logs ni archivos temporales.

### Web

Web sigue siendo aplicación Web pura. No puede usar Tauri/helper Desktop. La viabilidad de temporary auth keys MTProto directamente desde el navegador debe probarse sin introducir una credencial permanente ni un relay de archivos. Si el navegador no puede mantener el límite de confianza requerido de forma aceptable, la tarea permanece bloqueada; no se sustituirá silenciosamente por upload vía Galer Cloud.

## 8. Origen de API / localhost

El discovery de producción por `http://127.0.0.1:4000` no se considera identidad suficiente.

Objetivo:

- Web: same-origin o API HTTPS fija aprobada.
- Desktop: API remota fija/configurada y autenticada.
- Cualquier servicio loopback imprescindible: autenticación criptográfica o secreto efímero de canal/proceso; nunca confiar solo en `127.0.0.1` + health check.

Esto es independiente del data plane directo con Telegram.

## 9. Browser y Tauri hardening a aprobar

Antes de cerrar 5.1 se debe definir:

- parser ID3 local/vendorized y versión fijada;
- CSP por plataforma;
- security headers Web;
- CORS exact-origin;
- sesión Web preferentemente HttpOnly + Secure + SameSite y política CSRF coherente;
- matriz de permisos Tauri: permiso -> feature -> plataforma -> justificación;
- reducción de scopes sin romper funciones requeridas.

## 10. Decisiones que este ADR NO toma todavía

No se aprueba todavía:

- TTL final de temp auth keys;
- librería MTProto final;
- reemplazo del Local Bot API;
- comportamiento exacto ante upload de 1.9 GB que cruza renovación;
- frecuencia segura de cambios de permisos;
- lista final de derechos base del transport bot;
- diseño final Web MTProto;
- implementación de CSP/cookies/CORS/Tauri scopes.

Todo lo anterior requiere prototipo y pruebas antes de implementación productiva.

## 11. Gate para aprobar este ADR

Este ADR solo pasa de `DRAFT` a `ACCEPTED` cuando:

1. el threat model 0051 tiene pruebas adversariales concretas;
2. el plan de migración/rollback 0051 conserva Direct y cero pérdida de datos;
3. se demuestra un prototipo de temporary auth key para bot;
4. se demuestra renovación transparente;
5. se prueba transferencia directa grande, incluido objetivo 1.9 GB;
6. se mide permission churn y comportamiento ante rate limit;
7. se valida que pin funciona con el mínimo derecho necesario;
8. se valida delete propio sin elevación o se documenta la excepción;
9. revisión independiente de seguridad aprueba los límites de confianza.
