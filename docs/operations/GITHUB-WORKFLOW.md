# GitHub — ramas, releases y estabilización Web + Cloud

**Corte:** 2026-10-27. **Repositorio:** `magosouljah/BeatGaler`. Esta guía no modifica ni autoriza producción.

## Referencias que no deben confundirse

- **Producción Web + Cloud beta.2:** commit `a8418223527f88e9d34db8e05abb10216942013c`.
- **Tag anotado existente:** `v0.9.0-beta.2` → **exactamente** `a8418223527f88e9d34db8e05abb10216942013c`; no mover, recrear ni borrar.
- **BLUEPRINT reorganizado:** PR #142, merge `1022add9e8f6135737a37a283d61bb426355955a`; es posterior al código desplegado y no representa un despliegue nuevo.
- **Base de `main`:** `1022add9` (beta.2 + documentación). No equivale a un nuevo build productivo.
- **`release/0.9.0-beta.2`:** congelar a efectos operativos; no integrarle beta.3.
- **`release/0.9.0-beta.1` y `stable-2026-10-21`:** referencias históricas.

## Flujo futuro

1. `main` es la rama de integración de **Web + Cloud** una vez que el propietario la seleccione como rama predeterminada y configure protección. No desplegar `main` automáticamente.
2. Crear trabajos cortos desde `main`: `feat/<tema>`, `fix/<tema>`, `docs/<tema>`, `chore/<tema>`.
3. Abrir PR hacia `main`; revisar alcance y diff, ejecutar CI pertinente Web/Cloud, corregir fallos relevantes y fusionar sin force-push. No basar seguridad de merge en checks fallidos por deuda antigua o en checks que no se ejecutan.
4. Para beta.3, estabilizar `main`, crear `release/0.9.0-beta.3` desde un SHA validado y promocionar **separadamente y con autorización** el SHA de producción. Crear el tag anotado `v0.9.0-beta.3` sobre el **SHA exacto publicado**, nunca automáticamente sobre HEAD documental. Registrar release como prerelease.
5. Hotfix: empezar desde el commit/tag de la versión afectada, abrir PR revisado, validar y desplegar únicamente mediante procedimiento independiente autorizado; volver a incorporar el arreglo a `main`.
6. Desktop/Tauri: pausado. Sus flujos manuales/históricos no forman parte de la ruta de publicación Web + Cloud.

## Auditoría histórica de ramas (2026-10-27)

- **Contenidas íntegramente por `release/0.9.0-beta.2` (sin commits exclusivos):** `docs/blueprint-post-beta2-20261027`, `feat/auth-public-registration-hardening`, `fix/live-bugs-physical-b2be28f`, `prep/phase3-step15-e2e`, `prep/0.9.0-beta.2-web`, `release/0.9.0-beta.1` y `stage1/real-multi-account-e2e`. Aunque estén contenidas, conservar referencias históricas relevantes y no borrar sin autorización.
- **Divergentes / commits exclusivos:** `integration-v0.9.0-alpha.4` (2 commits exclusivos frente a ancestro común, código Web/Cloud y pruebas), `hotfix/fresh-index-prod` (2 commits exclusivos) y `prep/phase4-public-launch` (6 commits exclusivos, incluye prototipos de facturación productiva y multipart). No fusionar ni borrar automáticamente.
- **Historial sin ancestro común:** `Galer-local-v0.9`. Conservar hasta decidir archivo/respaldo.
- Ninguna rama ni tag fue eliminado en esta organización.

## Pendientes de administración de GitHub

- **Default branch:** seguía siendo `integration-v0.9.0-alpha.4` al iniciar la auditoría. Tras verificar CI y repositorio: Settings → General → Default branch → `main`. Requiere acción del propietario porque la conexión actual no expone modificación de configuración del repositorio.
- **Reglas:** el único ruleset observado (`integration-v0.8.0-alpha.1`) apunta a una rama que ya no existe. Crear ruleset para `main` (PR, prohibir borrado y force-push) y proteger `release/*` y tags `v*` contra movimiento/borrado; mantener posibilidad explícita de crear tags de nuevos releases. Revisar bypass de administradores.
- **GitHub Releases:** no existía Release publicado al auditar. Crear prerelease `v0.9.0-beta.2` usando el **tag existente**, sin generar otro ni cambiar objetivo. No es un despliegue.
- **Actions:** se auditaron 32 YAML y se conservan 29 workflows activos después de la limpieza (3 archivados sin borrarlos). `Public Operations - Validate` sigue semanalmente desde `main` y solo valida archivos/scripts. `Build - Windows`, `Build - macOS`, `Release - Desktop Updater` y `Test - Desktop Portability` quedan manuales. Los controles Web/Cloud por PR y el escaneo de secretos siguen vigentes.
- **Deuda de CI:** PR #142 reportó fallos `Test - Desktop Portability` (`version:check`, Rust/macOS, Windows y supply chain) y `D7 - Direct Capability Authorization`; no atribuirlos automáticamente al cambio documental. La línea beta.2 todavía contiene `VERSION = 0.9.0-beta.1`. Resolver por PR técnico separado, sin alterar la versión ya desplegada durante esta organización.
- **Protección actual:** las ramas antigua predeterminada y `release/0.9.0-beta.2` reportaban `protected=false`. Configurar protecciones antes de eliminar otras referencias.
- Tras cambiar la rama predeterminada, verificar el siguiente run programado, los checks en un PR Web/Cloud y la URL del tag/release.

**Seguridad:** no usar este documento como autorización para desplegar, ejecutar migraciones, manipular RDS/EC2 o eliminar ramas/tags.

## Mantenimiento de GitHub Actions — 2026-10-27

- **Sin ejecuciones automáticas Desktop:** `test-desktop-portability.yml` queda disponible solo mediante `workflow_dispatch`. No elimina el historial ni las pruebas de Windows/macOS.
- **Retirados de Actions, preservados como archivos históricos:** `.github/workflows-archive/f4-25.1-functional-matrix.yml`, `f4-25.1-windows-import.yml` y `upgrade-21.2-staging.yml`. Sus triggers estaban ligados exclusivamente a la desaparecida `integration-v0.8.0-alpha.1`.
- **Actualizados los triggers de desarrollo:** `auth-public-registration-hardening.yml` escucha PR hacia `main` con cambios de autenticación Cloud y permite ejecución manual; `d7-direct-capabilities.yml` mantiene PR focalizados y ejecución manual; `direct-persistent-vault-assignment.yml` ya no observa pushes a una rama de trabajo eliminada.
- **Seguridad conservada:** `f0-0.20-secret-scan.yml` sigue en cada PR y ahora en pushes a `main`. `web-production-build.yml`, pruebas específicas de Cloud/billing y el chequeo semanal de operaciones no cambian.
- **Importante:** los fallos históricos permanecen en el historial Actions; corregir `VERSION=0.9.0-beta.1` y eventuales fallos D7/supply-chain requiere una tarea técnica independiente, no ocultar errores de CI en PRs con código afectado.
- **No se tocó código funcional, tags, ramas release ni producción.** Los archivos archivados se pueden recuperar de la historia Git y volver a `.github/workflows/` cuando se reanude Desktop.
