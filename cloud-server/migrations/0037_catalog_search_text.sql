BEGIN;

-- T20-N — Búsqueda de 1–2 caracteres a 1M filas (STOP-PERF filter_short_q p95 283 ms). EXPLAIN (ANALYZE, BUFFERS) real: el predicado
-- `name_search LIKE OR key_search LIKE OR bpm_display LIKE OR EXISTS(tags.search_key LIKE)` se planifica con un SubPlan hashed que hace un
-- Parallel Seq Scan de TODO catalog_beat_tags (todas las bibliotecas) en cada consulta (~310 ms de ~340). Aditiva, sin extensiones, sin jsonb.
--
-- search_text = name_search || chr(31) || key_search || chr(31) || bpm_display || (chr(31) || search_key de cada tag, por posición).
-- Los escritores del beat (commands.writeBeatDoc, operations IMPORT/REPLACE, staging.rebuildDerivedProjections) la calculan con
-- legacy-codec.projectBeat(...).searchText en la MISMA sentencia/transacción que reescribe los tags. Un q sin chr(31) no puede cruzar el
-- separador, así que `search_text LIKE %q%` es exactamente la disyunción de los cuatro predicados anteriores (SEARCH_PROFILE no cambia).
-- NULL = "aún sin proyectar": queries.js cae al predicado por campos (correcto, solo más lento) en esa fila.
ALTER TABLE catalog_beats ADD COLUMN search_text text;

UPDATE catalog_beats b SET search_text = b.name_search || chr(31) || b.key_search || chr(31) || b.bpm_display
  || coalesce((SELECT chr(31) || string_agg(t.search_key, chr(31) ORDER BY t.position) FROM catalog_beat_tags t
               WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id), '');

-- Defensa: si un escritor ajeno cambia name_search/key_search/bpm_display sin recalcular search_text, se invalida (NULL) en vez de quedar
-- obsoleto; la búsqueda cae al predicado por campos. Los escritores que sí la recalculan la dejan distinta y no se tocan.
CREATE FUNCTION catalog_beats_search_text_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.search_text IS NOT DISTINCT FROM OLD.search_text
     AND (NEW.name_search IS DISTINCT FROM OLD.name_search OR NEW.key_search IS DISTINCT FROM OLD.key_search OR NEW.bpm_display IS DISTINCT FROM OLD.bpm_display) THEN
    NEW.search_text := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_beats_search_text_guard BEFORE UPDATE OF name_search, key_search, bpm_display ON catalog_beats
  FOR EACH ROW EXECUTE FUNCTION catalog_beats_search_text_guard();

-- trashOne calcula `max(export_position) + 1` por biblioteca/generación: sin índice recorre TODAS las entradas de papelera (Seq Scan de
-- 99.687 filas = 31 ms medido a 1M, creciente con la papelera). Con este índice es un Index Only Scan Backward de 1 fila.
CREATE INDEX catalog_trash_entries_export_idx ON catalog_trash_entries(user_id, generation_id, export_position);

ANALYZE catalog_beats;

COMMIT;
