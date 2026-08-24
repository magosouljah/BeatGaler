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

### 4.1 Frontera a probar en M0

Telegram no documenta una API de “delegación remota” lista para usar. La especificación sí separa dos piezas del bind:

- el `encrypted_message` de binding se construye y cifra usando la **permanent auth key**;
- la llamada `auth.bindTempAuthKey` se envía a Telegram usando la **temporary auth key**.

Eso hace protocolariamente plausible que el lado controlado construya el binding sin entregar la permanent auth key al dispositivo, mientras el dispositivo conserva la temp key y realiza el RPC directamente contra Telegram. **Sigue siendo hipótesis hasta demostrarlo end-to-end con nuestra stack.**

El probe M0 debe verificar que el lado controlado solo reciba metadata de binding necesaria (por ejemplo temp auth key id, temp session id, nonce, expiry y msg_id) y que nunca reciba ni transporte bytes del archivo.

### 4.2 Flujo candidato

```text
1. Galer/controlado mantiene la autorización permanente del transport bot.
2. BeatGaler genera una temporary auth key directamente contra Telegram.
3. BeatGaler entrega al binder solo metadata necesaria para construir el binding.
4. El binder construye encrypted_message con la permanent auth key y lo devuelve.
5. BeatGaler invoca auth.bindTempAuthKey directamente contra Telegram usando la temp key.
6. BeatGaler conserva la temporary key únicamente en RAM.
7. BeatGaler transfiere archivos directamente a/desde Telegram usando MTProto.
8. Antes de expirar, se prepara silenciosamente una nueva temporary key.
```

Ningún paso autoriza a Galer a recibir los bytes de MP3/WAV/ZIP/artwork/samples.

### 4.3 Renovación transparente

La expiración no debe interrumpir al usuario.

```text
T0      Key A activa
T0+N    Key B se crea y liga antes del vencimiento
T0+N+1  nuevas operaciones usan Key B
T0+N+2  Key A deja de usarse y desaparece de RAM
```

Debe existir margen suficiente para terminar operaciones en vuelo o reanudarlas sin corrupción. El TTL final no se fija en este ADR hasta medir latencia, uploads largos, reconexión y comportamiento de Telegram.

## 5. Defensa adicional: membresía y permisos mínimos estables

Las temporary auth keys limitan **cuánto tiempo** una sesión robada puede ser útil, pero no crean por sí solas scopes por vault u operación. Por eso deben combinarse con aislamiento por bot/vault y mínimo privilegio.

### 5.1 Membresía

Un transport bot solo debe estar presente en los vaults que le correspondan según las leases activas. El allocator conserva la regla de reparto justo por carga.

Membership no equivale automáticamente a tenant scope si un mismo bot está simultáneamente en varios vaults. Ese caso debe probarse adversarialmente antes de permitir compartir transport bots entre tenants.

### 5.2 Permisos baseline

El bot mantiene de forma estable únicamente los permisos realmente necesarios para las operaciones normales.

- `pin_messages` puede permanecer baseline si las pruebas confirman que es imprescindible para el índice fijado.
- `delete_messages` puede necesitar permanecer baseline si BeatGaler debe borrar mensajes creados por **otro** transport bot. No se asumirá que “el bot puede borrar sus propios mensajes” cubre ese caso.
- no se concederán derechos administrativos no utilizados.

La lista final de baseline rights se decide por pruebas funcionales reales, no por conveniencia.

### 5.3 Permission churn dinámico: fuera de la arquitectura principal

Por ahora BeatGaler **no** diseñará:

```text
operación -> grant delete -> borrar -> revoke delete
```

ni promote/demote por chunk u operación.

El probe aislado de PR #12 demostró que cambios administrativos frecuentes pueden entrar en `FLOOD_WAIT`, y que el mismo rate limit puede impedir una restauración inmediata de derechos. Por eso un grant/revoke frecuente no puede considerarse un mecanismo de seguridad fiable.

Resultado observado el 2026-08-24:

- primera corrida: 80 cambios exitosos a 5 s, 2.5 s, 1 s y 500 ms, sin `FLOOD_WAIT`;
- segunda corrida poco después, a 250 ms: después de 20 cambios de esa corrida Telegram devolvió `FLOOD_WAIT 533s`;
- la restauración automática inmediata también recibió `FLOOD`.

La actividad acumulada de la primera corrida puede haber contribuido. **No se interpreta esto como “el límite es 20”.** La conclusión válida es únicamente que churn frecuente puede bloquear tanto el cambio como su restauración.

Permisos dinámicos quedan fuera de la arquitectura 5.1 principal hasta que nueva evidencia justifique reabrir esa decisión.

## 6. Escalabilidad

La seguridad no puede depender de cambios administrativos excesivamente frecuentes.

Reglas:

- no permission churn por chunk u operación normal;
- permisos baseline mínimos y estables;
- membership changes solo cuando la lease realmente lo requiera, con medición y backoff;
- métricas de joins/leaves, temporary-key bindings/renewals y `FLOOD_WAIT`;
- admission control si la capacidad segura del pool se agota;
- nunca ampliar blast radius solo para aumentar throughput;
- no compartir transport bot entre tenants hasta demostrar aislamiento aceptable.

Telegram no publica una cifra universal que garantice una frecuencia segura para cambios administrativos; la capacidad debe medirse antes de producción.

## 7. Separación Desktop / Web

### Desktop

La temporary auth key debe vivir únicamente en el runtime nativo, no en React, localStorage, SQLite, logs ni archivos temporales.

### Web

Web sigue siendo aplicación Web pura. No puede usar Tauri/helper Desktop. La viabilidad de temporary auth keys MTProto directamente desde el navegador debe probarse sin introducir una credencial permanente ni un relay de archivos.

Una temp key en JavaScript/WASM es temporal, **no secreta frente al propio cliente ni frente a XSS**. El threat model debe tratarla como credencial robable con TTL y blast radius controlado, no como secreto inaccesible.

Si el navegador no puede mantener el límite de confianza requerido de forma aceptable, la tarea permanece bloqueada; no se sustituirá silenciosamente por upload vía Galer Cloud.

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

- viabilidad end-to-end del split permanent-side/temp-side;
- TTL final de temp auth keys;
- librería MTProto final;
- reemplazo del Local Bot API;
- comportamiento exacto ante upload de 1.9 GB que cruza renovación;
- lista final de derechos baseline del transport bot;
- diseño final Web MTProto;
- política final para transport bots compartidos entre tenants;
- implementación de CSP/cookies/CORS/Tauri scopes.

Todo lo anterior requiere prototipo y pruebas antes de implementación productiva.

## 11. Gate para aprobar este ADR

Este ADR solo pasa de `DRAFT` a `ACCEPTED` cuando:

1. el threat model 0051 tiene pruebas adversariales concretas;
2. el plan de migración/rollback 0051 conserva Direct y cero pérdida de datos;
3. se demuestra que la permanent auth nunca llega al cliente;
4. se demuestra un prototipo de temporary auth key para bot y bind split controlado/cliente;
5. se demuestra renovación transparente;
6. se prueba una operación larga cruzando renovación sin corrupción/duplicado;
7. se prueba transferencia directa grande, incluido objetivo 1.9 GB;
8. se valida Windows, macOS y Web pura;
9. se valida pin con el mínimo derecho necesario;
10. se valida delete propio y delete de mensajes creados por otro transport bot para fijar el baseline real;
11. se prueba cross-vault con bot compartido y se decide si compartir entre tenants se prohíbe o limita;
12. revisión independiente de seguridad aprueba los límites de confianza.

Hasta entonces, 5.1 permanece **EN PROGRESO / NO-GO**.