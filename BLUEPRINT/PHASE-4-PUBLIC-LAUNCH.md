# Fase 4 — puente real entre Fase 3 y usuarios públicos

Estado: **NO-GO para dinero real y usuarios públicos**. Esta preparación parte de `bafacba9c6b03948f6081831a7f58723d4467092` en `prep/phase4-public-launch`; STEP 14 y el worktree STEP 15 siguen independientes. Ninguna observación aquí autoriza cambiar producción.

## Lo que se observó, no lo que se supone

El 10 de octubre de 2026, una sonda pública de solo lectura (`node scripts/preflight-public-launch.mjs`) obtuvo:

- Web `/.well-known/source-sha.txt`: `206bed0fb577ef7c2949390a0bd29e1a81c57aa3`, anterior al punto de partida de esta rama (`bafacba…`). `/web-health` respondió `ok`.
- `/beatgaler-api/readyz`: HTTP 200, PostgreSQL `ready`, `environment: development`. `/beatgaler-api/auth/health`: auth y MASTER listos. La salud técnica no equivale a configuración productiva.
- Nginx en ambos archivos de configuración acepta solo `2m` para `/beatgaler-api/`. El catálogo permite PROJECT de `1_900_000_000` bytes y el navegador sube el ZIP entero mediante XHR a `/transport/project/upload`; Multer lo guarda temporalmente en el host. El runtime HTTP fija timeout de petición y socket en 30 s por defecto y no permite configurarlos por encima de 120 s; el navegador espera hasta 30 min. Subir el límite Nginx sin rediseñar el trayecto no resuelve el contrato.
- El Web deploy es un script manual por SSH con `KeyPath`; su CI solo construye y comprueba sintaxis en la base auditada. Allí cambia `current` antes de completar TLS, Nginx y smokes y no restaura automáticamente el symlink anterior si uno de esos pasos falla. Esta rama añade rollback local y fixture Linux; todavía falta ensayo en el host real y la verificación pública posterior al SSH. No hay workflow de deploy/rollback Cloud.
- Billing Web inicializa únicamente `BILLING_PROVIDER_ENVIRONMENT=sandbox`; checkout, webhook, lifecycle y reconciliación comprueban ese mismo adaptador. El catálogo admite el concepto `production`, pero eso no hace cobrable el runtime. Un token live no es un cambio de configuración suficiente.
- `src/components/SettingsPanel.tsx` publica Privacidad y Términos con `[Developer or company name]` y `[your-email@example.com]`, y fecha fija de agosto de 2026. La identidad y el texto legal finales necesitan datos del operador y revisión adecuada antes de usuarios reales.
- `cloud-server/OPERATIONS-OBSERVABILITY.md` declara un contrato solo de software; el repo no acredita backend externo de métricas, entrega de alertas, retención ni on-call. La prueba de backup de CI usa un modelo de desarrollo, no un backup/PITR productivo.
- En GitHub se observan secretos de Telegram/desktop y ningún environment ni secreto de deploy/Billing/RDS visible en este repo. Eso **no prueba** que no exista infraestructura fuera de GitHub. En este entorno no hay AWS CLI, credenciales AWS ni clave SSH EC2; por tanto no hay verificación directa de RDS/KMS/host ni ensayo de restore.
- `npm audit --omit=dev` en el Cloud lock base reportó `proxy-addr` crítico y `qs`/`ip-address` moderados. Esta rama actualiza solo esos tres locks a versiones corregidas y la auditoría queda en cero; hay que revalidar el resultado después de combinar con Fase 3. El root reporta cuatro avisos altos en la cadena `patch-package`/tooling, sin evidencia aquí de exposición directa al tráfico Web.

## Puertas que sí bloquean el lanzamiento con dinero

1. **Fase 3 cerrada y fusionada de forma controlada.** STEP 14 debe recibir sus eventos naturales y STEP 15 demostrar el E2E final sobre el SHA que se quiera liberar. Esta rama no toma sus fixtures, procesos ni estado. Después habrá que rebasar/combinar Fase 4 y repetir las pruebas afectadas.
2. **Trayecto financiero productivo.** Crear un adaptador/configuración Polar live separado, mapeos live verificados, webhook live firmado y separado por environment, checkout, inbox, lifecycle, reconciliación, portal y manejo de refund/disputa probados de extremo a extremo. Mantener fail-closed y evitar que credenciales Sandbox/libros Sandbox otorguen acceso productivo. Ensayar al menos un ciclo controlado de dinero real, reembolso y cancelación solo después de autorización operativa explícita; esta rama no cobra.
3. **Autoridad PostgreSQL y recuperación productiva.** El runbook de Task 5.2 sigue `NOT APPROVED`: RDS/equivalente, KMS y Secrets Manager con IAM mínimo, secretos versionados, backup cifrado, PITR, copia externa del snapshot, restore aislado medido (RPO <= 15 min; RTO <= 2 h), rotación de clave y un cutover/rollback ensayado. CI no sustituye esos hechos. Resolver quién ejecuta el write freeze y quién puede ordenar rollback.
4. **Contrato PROJECT cumplido o alcance comercial cambiado explícitamente.** El máximo prometido de 1.9 GB requiere transporte tolerante a cargas largas, reintentos y recuperación, sin depender de un único request Node de 120 s ni de espacio temporal sin capacidad probada. Evaluar upload directo desde Web a Telegram con capabilities ya existentes, o un flujo particionado/reanudable con staging dimensionado y commit verificable. Cada opción debe preservar autorización, bytes confirmados, INDEX/purge y no dejar media huérfana. Hasta probarlo con Telegram real y el proxy público, no anunciar PROJECT de 1.9 GB.
5. **Release y reversión demostradas.** Publicar exactamente el SHA aprobado, verificar `source-sha`, migración/compatibilidad DB y smoke Web/API; probar rollback de Web/Cloud y restauración de datos sin pérdida no prevista. Corregir el cambio temprano de symlink en el instalador y disponer de procedimiento reproducible/credenciales de operador. El marcador antiguo actual es una falla visible de release provenance.
6. **Operación y atención de incidentes.** Configurar entrega real de alertas para API/PG, Billing webhook/reconciliación, Telegram/MASTER, upload y backup/PITR; probar aviso a una persona designada, retención y escalación. Verificar que el status público refleje incidentes reales. `/readyz` debe reportar `production` y los checks críticos, sin usar un 200 como prueba de Billing o Telegram.
7. **Identidad legal y soporte.** Sustituir placeholders, aprobar Términos/Privacidad reales, revisar promesas de almacenamiento y planes contra la implementación, y probar canales de cancelación/soporte antes de cobrar.

## Trabajo que esta rama adelanta

- `POST /billing/portal` y botón Web de gestión: usa sesión autenticada, cuerpo vacío, CSRF del Web existente, customer binding PostgreSQL más comprobación de identidad remota, callback del servidor y URL HTTPS del Polar Sandbox. No cambia entitlements ni habilita producción. Polar documenta sesiones por `external_customer_id` y `return_url`: <https://polar.sh/docs/api-reference/customer-portal/sessions/create>. La capacidad real de cambiar plan dentro del portal todavía requiere E2E de lifecycle; por eso la interfaz no la promete.
- `scripts/preflight-public-launch.mjs`: sonda externa de solo lectura para SHA servido, Web, readiness PostgreSQL/entorno y auth/MASTER. Acepta origen y SHA esperado; falla si no coinciden. No comprueba Billing, backup, alertas ni capacidad de upload.
- `deploy/web/install-web-production.sh`: conserva symlink/config Nginx anteriores y los restaura si TLS o los smokes locales fallan; fixture de fallo inducido en Linux agregado al workflow de build. El despliegue público y su rollback aún requieren ensayo operativo; esta corrección no se ha enviado al host.
- Pruebas con proveedor simulado para el portal y la sonda; ningún secreto o checkout real.
- `cloud-server/package-lock.json`: actualiza `proxy-addr` 2.0.8, `qs` 6.16.0 e `ip-address` 10.7.3 para cerrar la auditoría de dependencias runtime, sin cambio de API.

## Puede esperar sin bloquear el primer usuario, si se declara el alcance

- Analytics de producto y atribución comercial: son útiles, pero no justifican retrasar un release que ya tiene logs, errores y alertas suficientes. Acordar privacidad antes de agregar trackers.
- Cambio de plan desde la interfaz propia Web: el portal del proveedor puede ofrecerlo, pero solo se puede prometer tras validar sus eventos, prorrateos y Access. Gestión básica/cancelación y facturas sí son requisito para cobrar.
- Automatizar por completo todos los deploys: un runbook manual repetible y un rollback ensayado bastan para un primer corte controlado; los scripts actuales todavía no alcanzan esa condición.
- Scheduler Web autónomo de purge a 14 días: el purge manual y el disparador Desktop están documentados en Fase 3. Tratarlo como deuda operacional explícita y vigilar acumulación; se vuelve bloqueo si la promesa pública exige borrado automático puntual.

## Secuencia mínima después de Fase 3

1. Congelar SHA de Fase 3 y resolver el merge aislado de esta rama; repetir Billing V1, typecheck/build Web y E2E afectados.
2. Provisionar y medir infraestructura productiva, backup/PITR/restore, alertas/on-call; identificar configuración real del host y secreto externo sin copiar valores al repo.
3. Implementar y probar adaptador Polar live y transporte PROJECT seleccionado. Mantener checkout live desactivado hasta E2E, legal y operación.
4. Ensayar release y rollback en staging equivalente; verificar SHA público con la sonda y errores después del rollback.
5. Realizar cutover productivo aprobado, prueba de dinero real controlada y observación de webhook/Access/reembolso; abrir a usuarios gradualmente solo con evidencia de todas las puertas anteriores.
