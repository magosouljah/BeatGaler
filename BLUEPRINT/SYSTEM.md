# BeatGaler — Stupid Simple System

Este archivo explica cómo usamos humanos + IA para avanzar BeatGaler hacia V1.

No explica cómo funciona BeatGaler. Eso pertenece a `V1.md`, `ARCHITECTURE/`, GitHub y el código.

## Fuentes de verdad

Cada tipo de verdad tiene un solo lugar:

- `V1.md` → qué queremos que sea BeatGaler V1.
- `ROADMAP.md` → dirección suave hacia V1; no estado diario ni plan rígido.
- `ARCHITECTURE/` → cómo funciona una arquitectura canónica que Bruno decidió conservar.
- `PIZARRA.md` → pensamiento temporal y desechable.
- GitHub → trabajo vivo e historia: Issues, PRs, commits y CI.
- Código + tests + runtime → lo que existe y lo que realmente funciona.

GitHub y runtime prevalecen sobre cualquier snapshot viejo.

No duplicar en documentos el estado que GitHub ya conserva.

## Cómo avanzamos

`ROADMAP.md` dice aproximadamente en qué escalón estamos y hacia dónde sigue V1.

Dentro del escalón actual elegimos el problema más importante y trabajamos uno a la vez siempre que sea posible.

```text
PROBLEMA
→ entender la realidad actual
→ decidir qué queremos
→ planear solo lo necesario
→ dividir si hace falta
→ implementar
→ comprobar comportamiento y regresiones
→ limpiar
→ integrar
→ cerrar
→ elegir el siguiente problema
```

Solo se planifica con detalle el problema que estamos a punto de trabajar. El futuro lejano se mantiene como dirección, no como implementación rígida.

Un problema independiente que deba sobrevivir se registra en GitHub; no se convierte el roadmap en una lista viva de tareas.

## Contrato de cada problema

Antes de implementar debe poder resumirse así:

```text
PROBLEMA
OBJETIVO
NO ROMPER
PUNTO DE PARTIDA
PRUEBA DE CIERRE
LIMPIEZA
```

- **PROBLEMA** → qué está mal de forma concreta y observable.
- **OBJETIVO** → cómo debe comportarse BeatGaler cuando termine.
- **NO ROMPER** → comportamientos y contratos actuales que deben sobrevivir.
- **PUNTO DE PARTIDA** → realidad actual relevante: código, branch/SHA, Issue/PR y evidencia existente cuando aplique.
- **PRUEBA DE CIERRE** → qué evidencia demuestra que el problema realmente quedó resuelto.
- **LIMPIEZA** → qué hacks, caminos viejos, instrumentation o complejidad temporal deben desaparecer antes de cerrar.

Si todavía no entendemos el problema o no sabemos qué comportamiento queremos conservar, primero se investiga. No se adivina una implementación.

## No romper cosas

Los tests son una capa de protección, no la única.

Antes de cambiar algo, identificar brevemente su superficie de impacto: qué flujo, componentes, contratos y comportamientos vecinos podrían verse afectados.

Después del cambio se usa la evidencia que aplique:

- tests y regresiones;
- CI;
- runtime real cuando CI no puede demostrar el comportamiento;
- flujos vecinos que dependen de lo tocado;
- casos de fallo relevantes: red, sesión, datos viejos, retry, offline u otros según el problema;
- comparación antes/después cuando importa rendimiento, requests, estados, memoria o comportamiento observable;
- revisión del diff para detectar cambios accidentales, duplicación o scope innecesario.

No todas las tareas necesitan todas las pruebas. Deben cubrir el riesgo real del cambio.

Una tarea no está terminada solo porque compila, el test está verde o el happy path funciona una vez.

## Cierre limpio

Un problema se cierra cuando:

1. el comportamiento objetivo funciona;
2. existe evidencia suficiente para el riesgo cambiado;
3. no se rompió el comportamiento que queríamos conservar;
4. el cambio quedó integrado sobre la realidad actual;
5. no dejó basura innecesaria.

Antes de cerrar:

- quitar hacks temporales que ya no sean necesarios;
- quitar instrumentation temporal que ya cumplió su propósito;
- evitar dejar dos caminos para hacer lo mismo;
- retirar o adaptar código y tests que protejan comportamiento que conscientemente dejó de pertenecer a BeatGaler;
- no mezclar refactors o features independientes solo porque estamos tocando la zona;
- actualizar `ARCHITECTURE/` únicamente si Bruno decidió conservar una nueva arquitectura o cambiar una existente.

La meta no es que el fix funcione encima de todo lo anterior. La meta es que BeatGaler quede más simple o, como mínimo, no más confuso que antes.

## Tests y regresiones

Los tests protegen comportamiento que queremos conservar; no son sagrados por existir.

Cuando un cambio deja un test rojo, primero averiguar qué comportamiento protegía.

- Si ese comportamiento sigue siendo parte de BeatGaler → conservarlo; corregir código o adaptar el test a la nueva arquitectura.
- Si Bruno decidió que el comportamiento ya no pertenece a BeatGaler → cambiar código y test de forma coherente.
- Si no sabemos cuál de las dos → investigar o escalar.

## Problemas inesperados

Si aparece algo pequeño y directamente causado por la tarea, se resuelve dentro de ella.

Si aparece un problema independiente, se registra y no se ensancha el trabajo actual sin necesidad.

Si aparece una contradicción que cambia qué queremos, una arquitectura canónica, seguridad importante, integridad de datos o una premisa central del plan, se detiene esa dirección y vuelve a Bruno/Genio.

## EL TRABAJADOR

Chat normal de IA. Es reemplazable y no necesita conocer toda la historia de BeatGaler.

Recibe el contrato del problema y el contexto estrictamente necesario.

Puede investigar el código necesario, implementar, corregir, añadir o adaptar tests, validar, limpiar y preparar/continuar el PR.

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

## EL SABIO

Modelo local con mucho tiempo, contexto completo y coste bajo.

Normalmente trabaja de noche.

Su trabajo es reconciliar la realidad:

- revisar lo que cambió;
- comparar código, tests, GitHub, `V1.md`, roadmap y arquitecturas canónicas relevantes;
- encontrar regresiones, contradicciones, duplicados y basura;
- señalar cuál parece ser el siguiente problema importante;
- señalar cuándo una premisa vieja ya no coincide con el proyecto actual.

Su output debe ser pequeño y accionable.

Si descubre algo que debe sobrevivir:

- bug/trabajo → GitHub Issue;
- decisión de producto → `V1.md` cuando Bruno lo decida;
- arquitectura aceptada → `ARCHITECTURE/` cuando Bruno lo decida;
- cambio amplio de dirección → `ROADMAP.md` cuando realmente cambie el escalón;
- nada importante → no se conserva.

No mantiene un diario permanente.

## Documentos

Permanentes:

- `V1.md`
- `ROADMAP.md`
- `SYSTEM.md`
- `BRUNO.md` (*recordatorios personales de Bruno; no reglas normales de IA*)
- arquitecturas canónicas dentro de `ARCHITECTURE/`

Desechable:

- `PIZARRA.md`

El trabajo normal no crea handoffs permanentes, logs manuales, ledgers de PRs, assignment IDs ni nuevos sistemas de estados.

GitHub ya conserva la historia.

## En corto

1. `V1.md` dice qué queremos.
2. `ROADMAP.md` dice aproximadamente hacia dónde seguimos.
3. `ARCHITECTURE/` dice cómo funciona lo que ya decidimos conservar.
4. GitHub dice qué estamos haciendo y qué pasó.
5. Código/tests/runtime dicen qué existe realmente.
6. Elegimos un problema importante del escalón actual.
7. Lo entendemos y definimos qué no debe romper.
8. Implementamos y verificamos según el riesgo real, no solo con tests.
9. Limpiamos antes de integrar y cerrar.
10. Repetimos hasta V1.
