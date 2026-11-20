# BeatGaler — pendientes después del lanzamiento PostgreSQL

**Fecha de referencia:** 20 nov 2026. **Producción:** catálogo PostgreSQL y transferencias a Telegram funcionando con 2 beats `ACTIVE`; véase [cierre LIVE](CIERRE-LIVE-2026-11-20.md). Estos pendientes **no invalidan** el resultado observado, pero no se deben presentar como terminados.

## A. Migración — deuda técnica y verificaciones restantes

| Prioridad | Pendiente | Estado actual | Criterio concreto para cerrarlo |
| --- | --- | --- | --- |
| **P0 de integridad** | **Backup de bytes de Telegram / recuperación de medios** | **NO CUBIERTO**. S3 contiene el dump SQL, no los MP3, WAV, portadas, MAIN ni PROJECT. Riesgo de copia única aceptado por el propietario para el lanzamiento | Política explícita de copias/recuperación y prueba real de recuperación sin pérdida; no confundir metadatos con medios |
| **P1 cierre técnico T25** | **Eliminar rutas y clientes de transporte legacy** | **PENDIENTE**, aunque la ruta nativa pública funciona. Restan `POST /transport/project/upload`, `POST /transport/index/publish`, consumidores antiguos y compatibilidad histórica | Inventario de dependencias, sustitución/bloqueo efectivo, tests, retirada del código legacy sin afectar Web nativa ni datos existentes; después dictamen de T25 |
| **P1 verificación** | **G2 / T11 completo** | **NOT_PROVEN**. E5 bloqueado sin prueba de unicidad; E8 residual; E7 omitido deliberadamente; tokens existentes reutilizados | Revisar riesgos y cercos efectivos con evidencia real; **sin rotación obligatoria ni Bot20**, salvo nueva decisión explícita del propietario. No inventar PASS |
| **P1 verificación** | **G3 / V09 manual** | **SIN DICTAMEN** | Pruebas del propietario en navegador/Edge, zoom, teclado, lector y casos V09 pertinentes |
| **P1 recuperación** | **Restore del último dump SQL** | El último backup se guardó y verificó su manifiesto, pero **su restore específico NO se ejecutó**. Existió restore aislado PASS de un backup anterior | Restaurar `bk-20261120T075417-26296` en entorno **aislado**, sin acceso a producción ni Telegram, y cotejar 42 migraciones, 2 cuentas, 2 beats activos y 4 referencias |
| **P1 usuario** | **Reproducción y descarga real tras migración** | Subida/comprobación de bytes en proveedor + commit real **PASS**; reproducción/descarga tras corte **no verificadas en este cierre** | Desde navegador, reproducir/descargar un beat ya guardado y verificar audio/archivo y metadatos tras recarga |
| P2 operación | **T24, papelera, purga y residuos** | No se ha aprobado limpieza física automática en producción; retención y journal requieren sus propios criterios | Confirmar políticas de retención y reconciliación, probar rutas destructivas en entorno controlado antes de habilitarlas |
| P2 capacidad | **Más de 500 beats / 1 millón** | **Fuera de alcance inicial**: 500 beats/biblioteca es el límite aprobado; 1M con limitaciones conocidas | Abrir proyecto de rendimiento solo si el producto lo requiere; no bloquear retroactivamente el GO-LIVE |
| P2 histórico | **T17 como gate formal** | **Omitido por decisión del propietario**: se usó flujo operativo de activación `REUSED_UNROTATED` con verificaciones SQL reales | Conservar como `SKIPPED/WAIVED`, **nunca** etiquetar PASS |

**Regla:** no deshacer la activación PostgreSQL ni resucitar INDEX para resolver pendientes. Las nuevas transferencias quedan en PostgreSQL; un envío incierto no se reenvía a ciegas. Cada pendiente se cierra con su propia prueba y evidencia.

## B. Producto — pendientes de lanzamiento que no son la migración

| Prioridad | Pendiente | Evidencia/estado | Próxima acción |
| --- | --- | --- | --- |
| **P1** | **Comprobar usuario final tras subir** | El propietario confirmó que los dos beats ya quedaron; SQL `ACTIVE=2`, cola del worker vacía | Probar recarga, reproducción, navegación y descarga en la cuenta real antes de declarar UX completamente PASS |
| P1 | **Pantalla «Crear cuenta» con Google y X** | Botones implementados en `src/features/auth/AuthExperienceGate.tsx` y `src/components/AccountGate.tsx`, pero **el build publicado NO los contiene** | Compilar fuera de la EC2 pequeña (Vite agotó memoria en instancia de ~913 MiB), probar y publicar nuevo build Web; comprobar creación real |
| P1 | **Nombre/perfil de cuenta creada con X** | Back-end guardó username y proveedor X; usuario reportó cuenta sin nombre y «Connect with X» | Diagnosticar DTO autenticado, sincronización de proveedores y estado del cliente; corregir y probar sin vinculación duplicada |
| P1 | **Planes para usuario autenticado y checkout** | `GET /beatgaler-api/plans/catalog` **HTTP 200** tras reinicio; error 502 anterior. `plans/me` sin sesión dio 401 esperado | Probar `plans/me`, precios, botones, checkout y confirmación de pago **autenticado**; no marcar facturación PASS por catálogo público 200 |
| P1 | **Restablecer contraseña de punta a punta** | Endpoint de solicitud `/auth/password/reset/request` dio **202**, `delivery_configured=true`, con correo ficticio; **no** prueba recepción ni uso de código | Test de envío y entrega a email controlado, restablecimiento efectivo, revocación de sesión y reingreso |
| P2 | **Más bots de Telegram en producción** | Pool operativo comprobado: **Bot01/02/03**. El propietario desea agregar los demás; no hay inventario completo aprobado ni prueba del resto | Inventariar bots existentes y sus sesiones/permisos, agregar por lotes seguros sin asumir «20 todos» ni rotar tokens por defecto |
| P2 | **Portadas reales en Landing** | Reportado por el propietario; **no modificado** durante el corte PostgreSQL | Sustituir portadas placeholder por arte real aprobado, con optimización/caché y revisión visual |
| P2 | **Deuda visual / regresiones Gallery** | Parte del pulido E79–E86 probado en LAB; no todos los casos manuales posteriores al corte están certificados | Validar aspecto, caché de portadas, estrellas, tags, Playbar y scroll profundo; no mezclar con arreglos del catálogo |
| P2 | **Build Web y límites de EC2** | Compilación `tsc` pasó a Vite; Vite se quedó sin memoria en EC2 ~913 MiB; procesos cancelados. Cloud y worker quedaron sanos | Construir con CI o runner externo/LOCAL y desplegar artefactos ya comprobados; no compilar junto al Cloud en la misma máquina pequeña |

## C. Política de seguimiento

- **Cerrado ahora:** despliegue PostgreSQL LIVE, asignación de bot a las 2 bibliotecas, worker durable, 2 transferencias verificadas/confirmadas, S3 SQL backup post-live.
- **No cerrado aún:** garantías formales G2/G3/T25, copia adicional de medios, pruebas de recuperación del backup nuevo y producto señalado arriba.
- No abrir un segundo proyecto de «migrar INDEX» ni repetir T00–T23 sin un defecto demostrado. Trabajar por tickets pequeños y no hacer cambios de producción sin la aprobación correspondiente.
- Antes de cambiar Cloud/Web, preservar releases activos, backup, `main` y la rama de trabajo; cada despliegue necesita health y reversión compatibles con PostgreSQL.
