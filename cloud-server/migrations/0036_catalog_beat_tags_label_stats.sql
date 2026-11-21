BEGIN;

-- T20-N — Estadísticas de planificador para catalog_beat_tags.label (NATIVO r2.1 §8.6, SLO de rendimiento).
-- Aditiva: no cambia esquema ni datos, solo el target de estadísticas de una columna y la re-analiza.
-- Diagnóstico real (EXPLAIN ANALYZE, BUFFERS sobre LAB a n=1M, ley de potencia de 500 tags): con el
-- default_statistics_target (100), el MCV de `label` solo capturaba los ~100 valores más frecuentes;
-- un tag raro (p.ej. el menos frecuente del vocabulario, 18 filas de 1.000.000) no entraba al MCV, así que
-- el planificador sobreestimaba su selectividad (Plan Rows ~2116 vs 18 reales) y escogía un Nested Loop Semi
-- con catalog_beats como lado externo (escaneando casi toda la tabla en orden) probando el índice de label
-- como lado interno una vez por fila externa — 900.313 probes, CATALOG_QUERY_TIMEOUT. Con esta migración el
-- MCV cubre prácticamente todos los valores del vocabulario, el planificador estima la selectividad real y
-- elige un Index (Only) Scan sobre catalog_beat_tags_label_idx como punto de partida: 8232 ms -> 15 ms medido.
ALTER TABLE catalog_beat_tags ALTER COLUMN label SET STATISTICS 1000;
ANALYZE catalog_beat_tags;

COMMIT;
