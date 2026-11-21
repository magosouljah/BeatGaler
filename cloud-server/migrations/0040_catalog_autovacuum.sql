BEGIN;

-- T20-N — Mantenimiento del catálogo grande. Aditiva: solo parámetros de almacenamiento por tabla (sin cambiar columnas, índices ni semántica).
-- Evidencia (1M filas, WSL LAB): tras trash/restore/patch el mapa de visibilidad de catalog_beats queda sucio y el COUNT con filtro de tag
-- (bucle anidado de sondeos index-only) cae al heap en ~41 % de los sondeos (2.849 de 6.854); un VACUUM lo dejó en 0 y bajó un 33 % las lecturas
-- en frío (9.163 -> 6.421 bloques). Con el umbral por defecto (20 % de filas de una tabla de 1M) el autovacuum tarda demasiado en actuar.
-- 2 % también mantiene al día las estadísticas del planner (una tabla sin ANALYZE hizo que la primera mutación pasara de ~100 ms a >1,4 s).
-- autovacuum_vacuum_insert_scale_factor (PG13+) hace que las cargas masivas (importaciones) también marquen páginas como all-visible.
ALTER TABLE catalog_beats SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE catalog_beat_tags SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE catalog_beat_tag_groups SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE catalog_facets SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE catalog_trash_entries SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

COMMIT;
