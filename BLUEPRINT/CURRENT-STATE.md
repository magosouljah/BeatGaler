# Estado — 27 de octubre de 2026

| Elemento | Hecho documentado |
| --- | --- |
| Publicación Web + Cloud | **`v0.9.0-beta.2`** |
| Referencia congelada | `release/0.9.0-beta.2` |
| SHA publicado | `a8418223527f88e9d34db8e05abb10216942013c` |
| Sitios | `beatgaler.com` / `api.beatgaler.com` |
| Desarrollo | `main` (no equivale a producción) |
| Carpeta local | `E:\777\app\BeatGaler` |
| Desktop/Tauri | Suspendido |
| Marketing | `magosouljah/MarketingBeatGaler` (separado) |

El responsable reportó pruebas funcionales satisfactorias de beta.2 el 26-10-2026. **Este documento no verifica el runtime de nuevo ni certifica todas las capacidades, cobros productivos, recuperación o escalabilidad.**

## Decisión Free / beneficios históricos

En `main`, PR [#144](https://github.com/magosouljah/BeatGaler/pull/144) y [#145](https://github.com/magosouljah/BeatGaler/pull/145) desactivaron el regalo automático de **7 días Paid Entry** por registro, verificación u OAuth. **Las cuentas nuevas comienzan en Free.** Los grants `source='welcome'` otorgados antes **conservan** fechas y vigencia hasta su expiración: no migrarlos, borrarlos, reiniciarlos ni revocarlos. La compatibilidad histórica del resolver y PostgreSQL se conserva. **Esto es política de `main`; no afirmar que ya está desplegada en beta.2.**

Promociones futuras con 100% de descuento serán gestionadas por Polar, tras validar condiciones y renovaciones; sin cuponera interna.

## Límites operativos

- **No** cambiar release, tag, producción, EC2/RDS, credenciales, infraestructura, datos de usuario ni cobros sin autorización independiente. No desplegar cambios documentales.
- [Incidente EC2 27-10-2026](OPERATIONS/INCIDENT-2026-10-27-EC2-NETWORK.md): recuperado, causa inicial no confirmada, **en observación**; no abrir investigación ahora.
- [Issue #133](https://github.com/magosouljah/BeatGaler/issues/133): comprobar aislamiento de DB de tests **antes** de ensayos destructivos o con escrituras.
- El código, los tests y los PRs son la prueba del estado de `main`; el SHA desplegado es una referencia distinta.

Para prioridades [DIRECTION.md](DIRECTION.md); reglas financieras [BILLING-V1-POLICY.md](BILLING-V1-POLICY.md).
