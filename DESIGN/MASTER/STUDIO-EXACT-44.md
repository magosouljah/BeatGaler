# Glass · Studio Original 44 — referencia de material

Punto de control independiente de Toolbar: MASTER → **Glass · Studio Original 44**.

- Contiene **un solo botón estático 44×44**, sin pulsación, bounce, deformación, nuevas máscaras ni iluminación artificial.
- Lee el preset de Studio exportado el **2026-11-02T23:59:40.405Z** (mismos controles ópticos que 23:23:31), preservado separadamente.
- Reutiliza **sin cambios** los shaders de \`DESIGN/MASTER/engines/studio/\` (incluidos \`lib/sdf.glsl\`, \`fragment-main.glsl\`, dos blur y bg), y \`MultiPassRenderer\`. No importa \`studio-toolbar-shape.glsl\`.
- Uniformes exactamente como \`src/App.tsx\` de \`iyinchao/liquid-glass-studio\`: radio de 100 % → 22 px en una figura 44×44; glareAngle convertido a radianes, intensidades/hardness /100, \`dpr=1\`, blur kernel original y \`u_refFresnelRange=0\` **sin parchear**.
- \`bgType:11\` refiere a **un fondo personalizado**, pero el JSON no contiene ni embebe su imagen. Por defecto se muestra una escena neutral, NO se asegura coincidencia con la captura del usuario. El input **Cargar fondo original** importa una imagen local directamente en Canvas/WebGL sin upload; permite usar el mismo fondo para comparación válida.
- El ícono de perfil se dibuja en una capa HTML encima, no modifica el cristal.
- Requiere revisión con el mismo fondo y tamaño de canvas que la demo original para intentar una comparación pixel-a-pixel. Aún no está integrada en la Toolbar.
- Esta prueba no modifica V1, V2, Gallery ni \`src/\`; producción y main intactos.

Referencia original: https://github.com/iyinchao/liquid-glass-studio/blob/main/src/App.tsx y sus shaders originales, MIT.
