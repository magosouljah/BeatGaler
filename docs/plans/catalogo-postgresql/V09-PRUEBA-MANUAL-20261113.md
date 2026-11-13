# V09 — Prueba manual del propietario (Edge, lector de pantalla, zoom, táctil, movimiento reducido)

**Para:** el propietario, en su propio equipo. Sin automatización ni acceso de Claude a su navegador. Evidencia previa automatizada: Chrome 152 (17 PASS) en [V09-INFORME](V09-INFORME-20261109.md). IDs de caso = [V09-MANIFIESTO](V09-MANIFIESTO-20261109.md).

## Preparación (una vez)
1. Terminal en la raíz del repo: `node scripts/catalog-lab/lab.cjs up --seed 300` (LAB aislado: Cloud real + Telegram **falso** + PostgreSQL efímero; no usa tus credenciales). Cuando termine, abre `http://127.0.0.1:1440/gallery`.
2. Cuenta de prueba: está en `tmp/catalog-lab/state/` (credenciales aleatorias del LAB; no las compartas).
3. Al terminar: `node scripts/catalog-lab/lab.cjs down`.

## Checklist (marca PASS / FAIL + nota)
| Caso | Qué hacer | Esperado |
| --- | --- | --- |
| Edge — carga | Abrir la URL en Edge. Ver Landing → Gallery | Igual que en Chrome: tarjetas, Tag Bar, Playbar; sin pantalla en negro |
| Edge — scroll | Scroll largo, Inicio/Fin, Re Pág/Av Pág | Sin saltos ni huecos; la tarjeta que suena no desaparece de la reproducción |
| Edge — búsqueda/tags/orden | Buscar, filtrar por tag, cambiar orden | Resultados globales; contador correcto |
| Lector (NVDA o Narrador) | Entrar a la lista con Tab | Anuncia lista/artículo con «n de total» (`aria-posinset/setsize`); Escape cierra menús; el foco nunca queda en vacío |
| Zoom 200 % | Ctrl + hasta 200 % a 1440 px | Sin scroll horizontal; Tag Bar y Playbar usables |
| Táctil | En un dispositivo táctil o modo táctil: tocar tarjeta, arrastrar, tocar tag | Selecciona y reproduce; scroll por arrastre fluido |
| Movimiento reducido | Activar «reducir movimiento» del SO | Sin animaciones de desplazamiento llamativas; todo funcional |

## Qué enviar
Una línea por caso (PASS/FAIL + navegador/versión + SO) y capturas solo de los FAIL. Registraré el resultado como evidencia manual (E47) para el dictamen de T16/G3; **no** declaro G3 por esto.
