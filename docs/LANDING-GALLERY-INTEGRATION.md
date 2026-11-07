# Landing y Gallery — integración de DESIGN

Estado: implementación preparada para revisión. La aceptación con sesiones y beats reales sigue pendiente; las pruebas visuales aisladas no certifican Cloud.

## Referencias

- Aplicación: `main`, commit `7f2dc5823a4d2cd87333ee3b6833ae46e9029b3b`.
- Diseño: `design/beatgaler-design-system-lab-v1`, commit `59ca3f0702d997c8917dd50ae9edf4822309a088`.
- Se trasladaron la órbita generada, el inset de Tag Bar, Studio 44, su preset y la presentación A de BeatCard. Los shaders y su licencia MIT se conservan en `src/features/design/MASTER/engines/studio`.
- Se mantienen los valores ópticos aprobados, las tarjetas de 160 × 239 px, las pills de 11 px, el reveal de tags y los resortes del laboratorio. Las variables trasladadas se limitan a `.bg-design`; sus neutros, espaciados y tiempos resuelven a los tokens del producto.

## Navegación y sesión

- `/`: Landing pública; no monta el gate de sesión ni la biblioteca. CTA **Create Gallery** → `/signup`; Log in → `/gallery`.
- `/gallery`: restaura la sesión mediante `AuthExperienceGate`; solo monta la aplicación después de confirmar una cuenta. Sin sesión muestra el inicio de sesión existente.
- `/signup` y `/login`: usan los flujos existentes. Al confirmar una cuenta, la URL pasa a `/gallery` conservando query/hash.
- Los enlaces antiguos `/?bgPage=…` conservan la página de biblioteca y pasan a `/gallery?bgPage=…`.
- El build Web utiliza rutas absolutas de assets para admitir `/gallery/` y recargas directas. Nginx ya contiene el fallback a `index.html`.
- Landing y aplicación se cargan en entradas diferidas distintas. La preconexión recordada de Direct se ejecuta en la experiencia autenticada.

## Conexión con la aplicación

Se conserva `useBeatGalerComposition`, la biblioteca autoritativa y el Player real. No se trasladan fixtures, audio simulado ni el Player del laboratorio al producto. Búsqueda, orden, selección, importación, edición, menús, descargas, Settings y logout llaman a los manejadores existentes.

La inclusión múltiple Web usa **ANY**, como Gallery de DESIGN; la exclusión tiene prioridad. Desktop conserva ALL. Clic alterna inclusión; Alt+clic alterna exclusión. Los colores continúan en el store existente y la paleta conserva Rename. La búsqueda de tags no distingue mayúsculas.

Stars se conecta al orden real por rating. El modelo actual no proporciona una fecha de creación de beat, por lo que no se muestra Date como una acción sin efecto. La variante de Tag Bar utilizada es Full black, el valor por defecto de DESIGN.

La Landing usa el generador original `bg-v1`. Las portadas fotográficas del laboratorio no se incluyen. Puede pausarse la órbita; se conserva su posición al pausar y se detiene con movimiento reducido o pestaña oculta. Studio mantiene controles CSS utilizables si WebGL no está disponible o pierde el contexto.

## Verificación

Ejecutar desde la raíz con Node 22.23.2 y las dependencias fijadas:

```powershell
npm ci
npm run test:unit:ts
npm run build:web
node scripts/test-public-operations-pages.mjs
node scripts/test-public-operations-pages.mjs --dist
node scripts/regression-web-startup-bridge.mjs
node scripts/regression-web-bound-temp-rpc.mjs
```

El workflow Web ejecuta además las 37 pruebas enfocadas de sesión, rutas, filtros, menús, arranque y navegación. El guard de arranque se actualizó para inspeccionar el listener nativo en su ubicación actual, `useBeatDownloads.ts`; el guard previo buscaba código ya extraído de `App.tsx` y fallaba en la base.

Para la inspección visual aislada:

```powershell
node node_modules/vite/bin/vite.js --mode web --host 127.0.0.1 --port 4180
```

- Landing real: `http://127.0.0.1:4180/`.
- Entrada de Gallery real: `http://127.0.0.1:4180/gallery`.
- Fixture visual: `http://127.0.0.1:4180/tests/visual/gallery.html`.
- Fallback gráfico: agregar `?noWebgl=1` a la fixture.

La fixture monta AppShell, BeatCard y Player reales con estado aislado explícitamente identificado. Se excluye del build productivo. No usa sesiones, datos de usuarios, Cloud ni audio real.

## Aceptación pendiente

Antes de fusionar/publicar, verificar en un entorno autorizado con Cloud configurado: restauración y login, registro/OTP, logout y cambio de cuenta, biblioteca vacía y cargada, reproducción/seek/cola, recarga, importación, edición, descargas, persistencia de tags y aislamiento entre cuentas. Revisar dispositivos táctiles y rendimiento en hardware real. La publicación de Web y Cloud no forma parte de esta entrega sin autorización independiente.
