# Interfaces del catálogo en M3 y M4

Decisiones aprobadas el 21 de noviembre de 2026 para la limpieza V1.

- **Edición 1A.** `catalogBeatEditor` ofrece una entrada por intención y comparte la lectura de resultados. La regla para resultados pendientes queda en un punto y la pantalla conserva sus efectos.
- **Importación 2A.** `catalogImportSession` agrupa revisión, progreso, operaciones pendientes y tarjetas provisionales en un almacén observable. Sigue el patrón de los almacenes del catálogo y preserva la secuencia de importación.
- **Reproducción 3B.** `catalogPlaybackLink` explicita la comunicación de la sesión con `useAudio`. Se conserva íntegro el motor compartido con Desktop para limitar el alcance de M3.
- **Biblioteca B.** `library-tx.js` aplica una política fija por módulo e intención con nombre. La tabla interna concentra las variantes y evita combinaciones de guardas en cada llamador.

**D13 aplicadas.** D13.1/2 unifican en 409 el rechazo por reglas SQL nativas. D13.5 protege el manifiesto MAIN bajo cuarentena igual que medios. D13.6 protege la escritura de conjuntos de consulta para que siga el criterio de lectura. D13.7 reserva el mensaje interno de PostgreSQL para el log del Cloud y conserva el SQLSTATE en la respuesta 503.

**D13 conservadas.** D13.3 mantiene Shuffle sin la guarda de congelación porque opera sobre la ronda. D13.4 mantiene accesibles los estados de transferencias, purgas y rondas bajo cuarentena para seguir operaciones en curso. D13.8 mantiene presupuestos distintos para MAIN, Gallery y el resto.

[Mapa técnico](../plans/catalogo-postgresql/ARQUITECTURA.md)
