# Nombres de los entornos de BeatGaler

| Nombre | Nombre t�cnico | Prop�sito |
| --- | --- | --- |
| **BeatGaler Producci�n** | Production / PROD | Aplicaci�n publicada en https://beatgaler.com. |
| **BeatGaler Local** | Local development / LOCAL | Aplicaci�n real ejecutada en localhost para probar cambios antes de publicarlos. |
| **BeatGaler Studio** | Design Lab / STUDIO | Laboratorio visual aislado ejecutado con `DESIGN/vite.config.ts`, normalmente en el puerto 4174. |

Usar **Producci�n**, **Local** y **Studio** como abreviaturas en conversaciones e instrucciones. El puerto de Local puede variar; la URL localhost por s� sola no identifica Studio.

MASTER, LANDING y GALLERY son vistas de Studio. MASTER en este contexto es el taller de componentes y no el MASTER t�cnico de Cloud.

La rama de integraci�n actual de Local es `codex/landing-gallery-integration-20261105`. La rama de Studio es `design/beatgaler-design-system-lab-v1`. Una rama de Git no es un entorno ni demuestra que un cambio se haya publicado.

## Playbar de Studio en Local

`src/components/Player.tsx` conserva el contrato real de reproducci�n y las capacidades de la plataforma. Su presentaci�n incorpora el comportamiento de `DESIGN/MASTER/Player.tsx` en el commit `59ca3f0`: altura de 68 px, portada de 48 px que pasa a 36 px al compactarse, espacio de 12 px entre portada y texto, seek bajo la portada en modo compacto y transici�n FLIP de 180 ms solo al cruzar el umbral de 760 px del dock. Se mide el ancho del dock, como hace Gallery de Studio con su contenedor.

Los estilos est�n acotados a `.bg-playbar-frame` en `src/components/player.css`, con los mismos tiempos y curva de Studio. El movimiento reducido desactiva las transformaciones animadas. La integraci�n no importa fixtures, audio simulado ni servicios del laboratorio.

Verificaci�n de navegador con Vite en ejecuci�n: `node scripts/check-studio-playbar.mjs`. Por defecto usa el puerto 4186; `PLAYBAR_TEST_URL` y `CHROME_BIN` permiten cambiar servidor y navegador. La fixture utiliza el Player real y estado aislado; no certifica reproducci�n con Cloud ni dispositivos f�sicos.

