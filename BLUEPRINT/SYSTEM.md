# BeatGaler — Stupid Simple System

Este archivo explica cómo usamos humanos + IA para avanzar BeatGaler hacia V1.

No explica cómo funciona BeatGaler. Eso pertenece a `V1.md`, `ARCHITECTURE/`, GitHub y el código.

## Fuentes de verdad

Cada tipo de verdad tiene un solo lugar:

- `V1.md` → qué queremos que sea BeatGaler V1.
- `ARCHITECTURE/` → cómo funciona una arquitectura canónica que Bruno decidió conservar.
- `PIZARRA.md` → pensamiento temporal y desechable.
- GitHub → trabajo vivo e historia: Issues, PRs, commits y CI.
- Código + tests + runtime → lo que existe y lo que realmente funciona.

No duplicar en documentos el estado que GitHub ya conserva.

## Flujo de trabajo

```text
PROBLEMA
→ entender la realidad actual
→ decidir qué queremos
→ planear solo lo necesario
→ dividir si hace falta
→ implementar
→ comprobar comportamiento y regresiones
→ integrar
→ cerrar
→ siguiente problema
```

Solo se planifica con detalle el problema que estamos a punto de trabajar. El futuro lejano se mantiene como dirección, no como implementación rígida.

## EL SABIO

Modelo local con mucho tiempo, contexto completo y coste bajo.

Normalmente trabaja de noche.

Su trabajo es reconciliar la realidad:

- revisar lo que cambió durante el día;
- comparar código, tests, GitHub, `V1.md` y arquitecturas canónicas relevantes;
- encontrar regresiones, contradicciones, duplicados y basura;
- investigar el siguiente problema importante;
- señalar cuándo una premisa vieja ya no coincide con el proyecto actual.

Su output debe ser pequeño y accionable.

Si descubre algo que debe sobrevivir:

- bug/trabajo → GitHub Issue;
- decisión de producto → `V1.md` cuando Bruno lo decida;
- arquitectura aceptada → `ARCHITECTURE/` cuando Bruno lo decida;
- nada importante → no se conserva.

No mantiene un diario permanente.

## EL TRABAJADOR

Chat normal de IA. Es reemplazable y no necesita conocer toda la historia de BeatGaler.

Recibe solo lo necesario para una tarea:

```text
PROBLEMA
OBJETIVO
NO ROMPER
PUNTO DE PARTIDA
PRUEBA DE CIERRE
```

Puede investigar el código necesario, implementar, corregir, añadir o adaptar tests y preparar/continuar el PR.

No decide libremente qué debe ser BeatGaler.

## EL GENIO

Recurso escaso y potente.

Se usa cuando la inteligencia adicional cambia realmente la calidad de la decisión:

- problema difícil o causa desconocida;
- arquitectura importante;
- varias soluciones plausibles con consecuencias grandes;
- seguridad, auth, datos, pagos o cambios difíciles de revertir;
- contradicción importante entre V1, arquitectura, código y tests;
- un plan dejó de ser válido por nueva evidencia.

Su trabajo principal es entender y decidir/planear el problema difícil.

No se usa para trabajo mecánico que puede hacer un Trabajador.

Después de un plan, se vuelve al Genio solo si aparece nueva evidencia que cambia una premisa importante.

## Tests y regresiones

Los tests protegen comportamiento que queremos conservar; no son sagrados por existir.

Cuando un cambio deja un test rojo, primero averiguar qué comportamiento protegía.

- Si ese comportamiento sigue siendo parte de BeatGaler → conservarlo; corregir código o adaptar el test a la nueva arquitectura.
- Si Bruno decidió que el comportamiento ya no pertenece a BeatGaler → cambiar código y test de forma coherente.
- Si no sabemos cuál de las dos → no adivinar; investigar o escalar.

Una tarea no está terminada solo porque el código compile.

Debe existir evidencia suficiente para el comportamiento cambiado: tests aplicables, regresiones aplicables, CI y runtime cuando CI no pueda demostrar el resultado real.

## Problemas inesperados

Si aparece algo pequeño y directamente causado por la tarea, se resuelve dentro de ella.

Si aparece un problema independiente, se registra y no se ensancha el trabajo actual sin necesidad.

Si aparece una contradicción que cambia qué queremos, una arquitectura canónica, seguridad importante o una premisa central del plan, se detiene esa dirección y vuelve a Bruno/Genio.

## Documentos

Permanentes:

- `V1.md`
- `SYSTEM.md`
- `BRUNO.md` (*ignorar, recordatorios de Bruno, no reglas normales de IA)
- arquitecturas canónicas dentro de `ARCHITECTURE/`

Desechable:

- `PIZARRA.md`

El trabajo normal no crea handoffs permanentes, logs manuales, ledgers de PRs, assignment IDs ni nuevos sistemas de estados.

GitHub ya conserva la historia.

## En 10 líneas

1. `V1.md` dice qué queremos.
2. `ARCHITECTURE/` dice cómo funciona lo que ya decidimos conservar.
3. GitHub dice qué estamos haciendo y qué pasó.
4. Código/tests/runtime dicen qué existe realmente.
5. Elegimos un problema importante.
6. Lo entendemos usando la realidad actual.
7. Genio solo si la decisión es difícil; si no, Trabajador.
8. Implementamos en piezas verificables sin romper comportamiento que queremos conservar.
9. Cerramos después de evidencia suficiente + integración.
10. El Sabio revisa de noche el drift y prepara el siguiente problema.
