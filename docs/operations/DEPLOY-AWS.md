# Despliegue AWS reproducible (V1)

**Regla:** Web y Cloud salen del **mismo commit de `main`** (el script se niega desde otra rama). Nunca se edita código en el host. Todo cambio pasa por git → `scripts/aws/deploy.sh`.

## Topología de producción

- EC2 `i-0053e156e4646e799` (`galer-cloud-prod`, us-east-2), nginx + `beatgaler-cloud.service` + `beatgaler-catalog-worker.service`.
- RDS PostgreSQL 18 `galer-cloud-prod`; credenciales en Secrets Manager (`beatgaler/prod/postgres`).
- Cloud: `/home/ec2-user/BeatGaler-releases/<sha12>/` (inmutable, `RELEASE_SHA`), activa = symlink `current`.
- Web: `/var/www/beatgaler-web/releases/<sha12>/` (con `.well-known/source-sha.txt`), activa = symlink `current`.
- **Estado persistente** (sesiones, vínculos de instalación, snapshots JSON, ciclo de vida, diagnóstico Direct): `/var/lib/beatgaler/state` (`BEATGALER_STATE_DIR`). Transporte (pool, MASTER, vaults): `/var/lib/beatgaler/runtime`. Ninguno vive dentro de una release.
- Arranque: `/usr/local/bin/beatgaler-start cloud|worker`, instalado desde `deploy/aws/beatgaler-start.sh` del SHA activo. Sin secretos en el script: los lee de `/etc/beatgaler-direct.env`, `/etc/beatgaler-production.env`, `/etc/beatgaler-oauth.env`, Secrets Manager y `LoadCredential`.

## Desplegar

```bash
aws login                      # sesión AWS válida
git push origin <rama>         # el SHA debe estar publicado
bash scripts/aws/deploy.sh
```

El script: comprueba árbol versionado limpio y push → `VITE_CATALOG_API_ENABLED=true npm run build:web` + `source-sha.txt` → `git archive` del Cloud → S3 (`beatgaler-deploy-…/releases/<sha>/`) → URLs prefirmadas (1 h) → SSM ejecuta `deploy/aws/activate-release.sh` de ese SHA.

`activate-release.sh`: verifica SHA-256 de artefactos; crea las releases (reutiliza `node_modules` si el lock es idéntico); respalda scripts/unidades en `/home/ec2-user/beatgaler-backups/activate-*`; la primera vez migra el estado a `/var/lib/beatgaler/state` y extrae X OAuth/MASTER a `/etc/beatgaler-oauth.env` sin imprimirlos; cambia symlinks atómicamente; arranca y exige `/readyz` con `sourceSha` = SHA y `source-sha.txt` = SHA. **Si algo falla, rollback automático** (symlinks + unidades anteriores). Nunca borra releases antiguas.

## Rollback manual

```bash
ln -sfn /home/ec2-user/BeatGaler-releases/<sha12-anterior> /home/ec2-user/BeatGaler-releases/current.tmp && mv -T …/current.tmp …/current
ln -sfn /var/www/beatgaler-web/releases/<sha12-anterior> /var/www/beatgaler-web/current.tmp && mv -T …/current.tmp …/current
systemctl restart beatgaler-cloud beatgaler-catalog-worker
```

## Flags efectivos (catálogo)

| Flag | LOCAL (LAB real3) | AWS |
|---|---|---|
| `BEATGALER_CATALOG_NATIVE_ENABLED` | true | true |
| `BEATGALER_CATALOG_DIRECT_ENABLED` | true | true |
| `BEATGALER_CATALOG_PREFIX_PACKS_ENABLED` | true | true |
| `BEATGALER_CATALOG_GATEWAY_ENABLED` | real preload (sandbox) | true |
| `BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED` | — | true (bots reutilizados sin rotar; **no** es G2 PASS) |
| `BEATGALER_CATALOG_DIRECT_PREWARM_BOTS` | 3 (por defecto) | 1 |
| `BEATGALER_CATALOG_JOURNAL_DIR` (eliminación física) | — | **no configurado** (deshabilitada a propósito) |
| Pool de bots | Bot20 `managed:false` | Bot01–03 gestionados por MANAGER (`getManagedBotToken`) |
