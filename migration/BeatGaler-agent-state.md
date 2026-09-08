# BeatGaler Agent State

## Seguridad de la ronda nocturna

- Rama exclusiva: `v0.9.0-test-noche`
- Prohibido modificar o avanzar `integration-v0.9.0-alpha.2`, `main` o ramas `app-tsx-*`.
- Prohibido merge, rebase, cherry-pick, fast-forward hacia otras ramas o PR de integración durante la prueba.
- Todos los commits y pushes de la ronda deben quedar únicamente en `v0.9.0-test-noche`.

## Estado operativo

- Tarea actual: `3.4 — Separar selección y reordenamiento`
- Estado: `Pendiente`
- Última tarea terminada: `3.3 — Separar búsqueda, filtros y etiquetas`
- Último SHA de implementación de tarea terminado: `1c415f318ac5f0c7c466f3f4cbb9ab28a8369c11`
- HEAD funcional de la rama nocturna antes de crear este contexto: `466811f80385768e8e3ae5bdf491d431891cd0ce`
- Pendientes concretos: ejecutar únicamente 3.4 según roadmap y plan.
- Comprobaciones pendientes de tareas anteriores: ninguna necesaria para reabrir 3.1, 3.2 o 3.3.
- Siguiente tarea prevista después de 3.4: determinarla desde el roadmap solo cuando 3.4 quede realmente Terminada.
- Fecha de inicialización: `2026-09-08`

## Regla de actualización

Al cerrar cada ejecución:
- si la tarea queda `Terminada`, marcar solo su `[x]` en el roadmap, agregar su registro al final de `Registro-de-avance.md` y dejar aquí la siguiente tarea como `Pendiente`;
- si queda `En curso` o `Por verificar`, mantener esa misma tarea como tarea actual y registrar exactamente lo que falta;
- nunca iniciar una segunda tarea en la misma ejecución.
