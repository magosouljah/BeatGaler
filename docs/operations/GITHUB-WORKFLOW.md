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
- **Actions:** se observaron 32 YAML de workflow en la línea beta.2. `Public Operations - Validate` corre semanalmente desde la rama predeterminada (solo validaciones, no despliegue). `Build - Windows`, `Build - macOS` y `Release - Desktop Updater` se lanzan manualmente. Hay triggers obsoletos para `integration-v0.8.0-alpha.1`, `release/0.9.0-beta.1` y ramas de trabajo ya cerradas.
- **Deuda de CI:** PR #142 reportó fallos `Test - Desktop Portability` (`version:check`, Rust/macOS, Windows y supply chain) y `D7 - Direct Capability Authorization`; no atribuirlos automáticamente al cambio documental. La línea beta.2 todavía contiene `VERSION = 0.9.0-beta.1`. Resolver por PR técnico separado, sin alterar la versión ya desplegada durante esta organización.
- **Protección actual:** las ramas antigua predeterminada y `release/0.9.0-beta.2` reportaban `protected=false`. Configurar protecciones antes de eliminar otras referencias.
- Tras cambiar la rama predeterminada, verificar el siguiente run programado, los checks en un PR Web/Cloud y la URL del tag/release.

**Seguridad:** no usar este documento como autorización para desplegar, ejecutar migraciones, manipular RDS/EC2 o eliminar ramas/tags.
