# Operación de reconciliación Billing Web

`server.js` configura el runtime con el mismo adapter Polar Sandbox validado de catálogo/checkout/lifecycle y sólo bajo autoridad PostgreSQL. Pending revisa hasta 50 usuarios por minuto; commercial revisa hasta 100 por cada 15 minutos. Ambas pasadas usan cursor por ID de usuario y se ejecutan sin overlap dentro del proceso. Al agotar una lista el cursor vuelve al principio. Reiniciar el servidor vuelve a recorrer la lista; las proyecciones son idempotentes. Otros procesos y el webhook serializan cada usuario con el mismo lock PostgreSQL, mantenido desde discovery hasta commit.

Pending incluye checkout `CREATING`/`OPEN`/`AMBIGUOUS`, subscription `past_due`/`unpaid`/`incomplete`, webhook `FAILED` con usuario resuelto y excepciones `OPEN`. Un shutdown cancela timers, deja de tomar usuarios nuevos y espera la reconciliación en curso antes de cerrar el pool.

La operación individual se ejecuta desde `cloud-server`:

```powershell
npm run billing:reconcile -- --user-id <ID-interno-BeatGaler>
```

La CLI lee `cloud-server/.env` sin imprimirlo. Exige PostgreSQL habilitado, autoridad `postgres`, marcador de cutover `READY` con el snapshot configurado y preflight de ambos mappings Polar. El usuario debe existir en `users`. No admite Product, Price, Customer ni Subscription IDs como autoridad, y no crea checkouts ni expone una ruta HTTP. Esta herramienta requiere acceso operativo al host y sus credenciales.

Exit 0 significa reconciliación inequívoca; 2 indica excepción durable sin repair; 1 indica fallo. El resultado publicado contiene sólo estado, reason y planes antes/después. La auditoría y la exception queue conservan snapshots allowlisted, sin URLs de checkout, raw webhook, secretos ni payloads completos del proveedor. Una reconciliación posterior inequívoca marca las excepciones del usuario/proveedor/entorno como `RESOLVED`.

Discovery limita cada lista a 100 objetos. Un resultado truncado, un mapping incompleto, una cobertura sin período explícito o un refund ambiguo exige excepción. Los escenarios financieros completos con Polar real corresponden a STEP 14; las pruebas de STEP 11 usan proveedor simulado y PostgreSQL temporal real.

```powershell
npm run test:billing-reconciliation
# El runner PostgreSQL exige BILLING_RECONCILIATION_TEST_ADMIN_URL con permiso CREATEDB.
npm run test:billing-reconciliation-pg
```
