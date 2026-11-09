# BeatGaler — Instrucciones para Claude Code

**Actualizado:** 2026-11-09  
**Proyecto:** `magosouljah/BeatGaler`  
**Rama exclusiva:** `local/landing-gallery-unificada`  
**Directorio LOCAL:** `E:\777\app\BeatGaler`  
**HEAD reconciliado (reportado y dictaminado):** `83b5abf983c4f51c0fddd71a45f3cbd755330fa9`  
**T05-N PASS (dictamen de Sol, 2026-11-09):** `5392b2f`, run `42549450777`.

## 1. Misión

Eliminar **definitivamente el INDEX de Telegram**. PostgreSQL será la única autoridad de metadatos y estado del catálogo; Telegram almacenará exclusivamente los archivos multimedia. Las bibliotecas nuevas nacen **nativas de PostgreSQL**, sin importar INDEX históricos ni volver a autoridad legacy.

Preservar sin cambios visuales la **Landing, Gallery infinita virtualizada, BeatCards, Tag Bar y Playbar** aprobadas. Gallery debe consultar búsqueda, filtros, orden y navegación globalmente en PostgreSQL, con DOM y memoria del cliente acotados. Desktop/Tauri queda fuera del alcance principal y debe permanecer cercado si resulta incompatible.

**No hay usuarios reales cuyos datos debamos migrar.** El propietario permite descartar material de prueba, pero **NO ha autorizado borrarlo** ni tocar servicios reales.

## 2. Fuentes y precedencia

Antes de ejecutar una tarea, leer *solo las secciones aplicables*, evitando releer o auditar todo sin motivo:

1. `docs/plans/catalogo-postgresql/NATIVO-POSTGRES-20261108.md` — **r2.1, arquitectura nativa vigente**; reemplaza la ruta histórica INDEX → PostgreSQL donde lo establece.
2. `ESTADO.md` — bloque superior vigente, después los antecedentes; verificar que refleje el avance actual.
3. `CONTRATO.md`, `C12-V00-CIERRE-20261107.md` y `C12-DECISION-RECORD.md` — invariantes y decisiones de producto **C12-r4**, superiores a actas abreviadas antiguas.
4. `TAREAS.md`, `EJECUCION-POR-NIVELES-20261107.md`, `MATRIZ-T-NIVELES-20261107.md` y `MATRIZ-V-NIVELES-20261107.md` — tareas, dependencias, niveles y tests; adaptar únicamente las partes anuladas expresamente por r2.1.
5. `README.md`, `EVIDENCIA.md`, `MIGRACION.md`, `C12-B-INTEGRACION-Y-PLAN-20261107.md` — contexto y criterios aplicables.
6. Instrucciones `AGENTS.md` vigentes, si existen, y este archivo.

**Orden ante contradicción:** restricciones explícitas del usuario y seguridad → NATIVO r2.1 para flujo nativo → C12-r4 para UX → contratos N1 que sigan vigentes → registros históricos. Registrar contradicciones materiales; no inventar contratos ni asumir PASS. El texto local de NATIVO r2.1 debe verificarse en el checkout real antes de ejecutar T05-N; no usar un resumen como sustituto.

## 3. Roles y política de autonomía

- **GPT-6 (Sol):** director técnico; resuelve arquitectura, STOP reales y dictámenes formales de gates.
- **Claude Code:** ejecutor. **MEDIA** por defecto; **BAJA** para tareas mecánicas, fixtures y verificaciones; **ALTA** solo para problemas arquitectónicos nuevos o revisión crítica expresamente necesaria.
- **Propietario (Purp):** autoriza operaciones reales, borrados, despliegues y decisiones de producto/arquitectura que alteren el contrato.

**Autorización de trabajo acordada (modo de ejecución continua, Sol 2026-11-09):** un **bloque continuo de implementación T06–T21 exclusivamente en LOCAL y CI efímero aislado**, condicionado a dependencias y gates. Claude verifica los criterios PASS de cada tarea con pruebas y evidencia, registra resultados en `ESTADO.md`/`EVIDENCIA.md` y **continúa automáticamente** con la siguiente tarea sin pedir dictamen por cada tarea rutinaria ni detenerse por un CI verde. Quedan autorizados los **commits normales y el push fast-forward exclusivamente a `local/landing-gallery-unificada`** para ejecutar el CI aislado, con verificación previa de archivos y ausencia de secretos. **No se amplía a T23–T25, sistemas reales, `main`, despliegues, borrados, force-push ni eliminación física.** Los gates que exigen aprobación independiente (G2 sandbox real, G4, activación) siguen requiriendo STOP y dictamen.

Después de cada T, registrar evidencia y estado; si las dependencias de la siguiente están satisfechas y no existe STOP, **continuar autónomamente**. No reiniciar chats, auditorías completas ni suites ya verificadas sin una causa técnica nueva. Una prueba obligatoria afectada sí se ejecuta.

## 4. Estado verificado y punto de partida

| Elemento | Estado |
| --- | --- |
| T00/G0 | **PASS** |
| T01 | **PASS** |
| T02 | **PASS** |
| T03 | **PASS** |
| T04 | **PASS** — CI `42530209790` sobre `3d291d5`; `83b5abf` solo cambió documentación |
| Git LOCAL | Reconciliación **PASS**, HEAD `83b5abf` |
| T05-N | **PASS** — dictamen de Sol sobre CI `42549450777` (`5392b2f`); evidencia E23/E23-b |
| T06–T17, T19–T21 | En ejecución continua según dependencias (T06 en curso desde 2026-11-09) |
| T18 y T22 | **NO APLICA** en ruta nativa; mantener identificadores y justificación histórica |
| T23–T25 | Fuera de autorización actual; requieren permisos independientes |

La reconciliación preservó **112/112 hashes** y la rama `backup/pre-recon-20261108` apuntando a `a4462191aea29ffdae136f04e1fdc2e4024291d1`. `stash@{0}` y `backup/autostash-20261028-011451` no deben tocarse.

**Estado local reportado al cierre:** 7 documentos modificados y 10 entradas sin seguimiento, incluidos C12-r4, NATIVO r2.1, este `CLAUDE.md` anterior, `Claude outputs/` e imagen del usuario. **No sobrescribir ni incluir archivos ajenos** por accidente. Confirmar `git status` real antes de actuar.

El árbol ejecutable de `83b5abf` es equivalente al probado en CI para T04. **No repetir T00–T04** ni ejecutar el antiguo runner T00: ya no es una verificación apropiada para un historial que contiene catálogo.

## 5. Secuencia corta de ejecución

**A. Cierre documental LOCAL (permiso de commit limitado):** actualizar este `CLAUDE.md`; conservar completos C12-r4 y NATIVO r2.1; reconciliar únicamente los documentos canónicos que aún describan el flujo histórico como vigente. Revisar lista exacta y diff, verificar respaldos SHA-256. Autorizar solo un **commit documental LOCAL** de archivos de plan seleccionados y este `CLAUDE.md`; **nunca incluir** `Claude outputs/`, imágenes o secretos. **No push** sin permiso separado. No alterar código para este commit.

**B. T05-N (PASS):** implementó autoridad nativa, provisionamiento explícito idempotente mediante `POST` y guardas fail-closed conforme a NATIVO r2.1. `GET /context` **solo lee**; ausencia de datos/error SQL nunca implica catálogo vacío. No crear INDEX ni consultar Telegram para inicialización. La ruta nativa debe impedir operaciones antiguas incompatibles *antes* de cualquier efecto externo; triggers SQL son defensa adicional, no cerco suficiente.

**C. T06–T17 y T19–T21:** seguir dependencias y requisitos nativos, ejecutar pruebas específicas y reutilizar evidencia válida. Tras T05, avanzar en lectura SQL, mutaciones, operaciones, worker, integración Web/Gallery/Playbar, transporte, backup/restore y rendimiento. No omitir integridad, concurrencia, aislamiento, retención ni recuperación para acelerar.

**D. T11/G2:** el contrato y revocación real de credenciales Telegram deben demostrarse en **sandbox aislado con permiso explícito**. Sin ese permiso, hacer únicamente pruebas con fakes y registrar el STOP aplicable; nunca declarar G2 PASS por mocks. No habilitar clientes nativos reales con `bot_token` crudo; su acceso previsto es a través de un gateway con capacidades limitadas, cuya latencia/costo se mide en T20.

**E. T19/G4:** demostrar restauración PostgreSQL posterior a activación, compatibilidad de binarios y recuperación operativa. **No existe rollback a INDEX.** Las copias SQL no sustituyen las copias de bytes multimedia.

**F. Activación:** T23–T25, despliegue, cambios de credenciales reales, limpieza de datos o medios, borrado de cuentas y modificaciones AWS/Telegram quedan **expresamente fuera** de este bloque. Se solicitan permisos específicos después de demostrar gates.

## 6. Invariantes que no pueden relajarse

- Solo vaults nuevos y elegibles pueden provisionarse; comprobar identidad SQL, origen y ausencia de rastros legacy. Si `vaults.id` discrepa entre JSON/SQL (**R12**), bloquear provisión y resolver la discrepancia, nunca elegir uno por intuición.
- Provisión y mutaciones: autenticación server-side, aislamiento por usuario, transacciones SQL breves, época/era, versiones, idempotencia, control de concurrencia y revisión; nada de esperas de Telegram dentro de una transacción.
- Los triggers de `0027` **no pueden impedir** acciones externas ya enviadas por clientes antiguos. El cercado efectivo requiere controlar procesos, credenciales y permisos antes de habilitar un entorno nativo; comprobar en T11.
- No permitir que clientes nativos reales reciban `bot_token` en claro. No convertir un objetivo de +150 ms p95 o un costo supuesto en garantía; medir T20 (**D-N6**).
- Proteger catálogo, generaciones activas y mapas físicos contra cascadas; borrar cuentas solo mediante proceso autorizado, durable y auditable, **actualmente deshabilitado**.
- `reset` **no vacía bibliotecas nativas**; nunca borrar medios, mensajes, INDEX de prueba o registros por la mera autorización general de descartarlos.
- Los cambios de chat/control-plane deben ser seguros y conservar referencias de archivos; un conflicto se rechaza y cuarentena el usuario afectado sin confirmar parcialmente sus datos. Fail-closed en fallas sistémicas.
- Resolver compatibilidad de tombstones `CATALOG` con exportador (**R11**) antes de necesitarlos, sin falsear roundtrip. Probar recuperación antes de una activación irreversible.
- La Gallery conserva diseño, navegación global, selección global, cola/Shuffle, tags y Playbar independientes de ventanas de tarjetas; no cargar toda la biblioteca en memoria.

## 7. Seguridad operativa y Git

- **Permitido:** cambios de código y documentación necesarios para T06–T21 **solo en LOCAL**, tests controlados y CI PostgreSQL efímero/aislado; commits normales y push fast-forward solo a `local/landing-gallery-unificada` (autorización de Sol 2026-11-09), con preflight de archivos y secretos.
- **Prohibido sin autorización adicional:** force-push, merge, rebase, reset, clean, stash, cambios de rama, push a cualquier otra rama, borrados, despliegues, migraciones en DB no efímeras, AWS, bots/cuentas/chats/Telegram reales, producción o `main`/`DESIGN/`.
- No ejecutar pruebas destructivas ni `postgres-live.integration.cjs` con variables heredadas. El arnés de T02 debe demostrar ownership de DB efímera y bloquear conexiones externas. No ejecutar suites agregadas de alcance desconocido.
- No leer, copiar, registrar ni mostrar `.env`, `.env.*`, credenciales o secretos. Usar los mecanismos seguros ya diseñados para mocks y laboratorios.
- No desactivar tests, checks, runner T00 ni guardas para forzar PASS. Nuevas pruebas deben medir el comportamiento, no acomodar resultados.
- Antes de **editar documentos del plan**, respaldo único bajo `E:\777\app\BeatGaler-plan-backups\` y SHA-256 verificado; no repetir copias redundantes del mismo estado.
- Git preflight por cada cambio relevante: rama/HEAD/status, AGENTS aplicables y diff de alcance. Proteger modificaciones sin seguimiento. Las escrituras Git distintas del commit documental limitado requieren permiso, salvo que una futura instrucción explícita las autorice.

## 8. Evidencia mínima y STOP

Por tarea registrar en `ESTADO.md`/`EVIDENCIA.md` un **resumen breve**: `Txx`, SHA/rama, archivos, comandos/pruebas y resultados, `PASS` técnico o `STOP`, y siguiente dependencia; no entregar handoffs rutinarios al cerrar cada tarea ni por un CI verde. Distinguir PASS aislado de evidencia real de proveedor; **Sol conserva el dictamen formal de los gates que exigen aprobación independiente**. No generar ZIP, reportes largos ni volver a auditar lo ya certificado, salvo necesidad técnica.

**Detenerse y escalar** ante: decisiones no resueltas de arquitectura/producto, riesgo real de integridad o seguridad, acceso a servicio real, prueba obligatoria fallida que no pueda corregirse de modo seguro, migración/borrado no autorizado o incompatibilidad contractual. Usar `STOP-BASE`, `STOP-ENV`, `STOP-TEST`, `STOP-DESIGN`, `STOP-CONTRACT`, `STOP-DATA`, `STOP-GATE` o `STOP-APPROVAL` con evidencia precisa.

**Regla de comunicación:** español, directo y muy breve. Priorizar calidad e integridad con el menor consumo de créditos y la máxima velocidad. Continuar el bloque autorizado sin volver a pedir permiso por trabajo rutinario.
