BEGIN;

-- E75 — MAIN de prefijos de audio (Documento Maestro §7.3, decisiones del propietario 2026-11-18). Aditiva.
-- El MAIN es SOLO almacenamiento de bytes en Telegram: concatena los primeros bytes (≤128 KiB) de los MP3 de una biblioteca para que un
-- dispositivo con la caché vacía los obtenga con una lectura. Lo construye y lo sube el NAVEGADOR (Direct B); el Cloud nunca lee ni envía sus
-- bytes: aquí solo viven la identidad del envío, la referencia al mensaje y las entradas. NO es un INDEX ni una autoridad: PostgreSQL decide
-- cuál es el MAIN vigente y qué archivos son actuales (catalog_current_files). Una entrada solo se sirve si su file_id sigue siendo el MASTER
-- vigente de un beat ACTIVE con el mismo SHA-256; lo vigente que el MAIN no cubre son los «pendientes» (el contador de cambios, derivado).
-- Ciclo: STAGED (ticket: identidad persistida ANTES del envío, una sola construcción en curso por biblioteca) → PUBLISHED (compare-and-swap
-- sobre base_seq, un único MAIN vigente) → SUPERSEDED al publicarse el siguiente. FAILED: abandonado, rechazado o perdedor de una carrera;
-- nunca es visible. En Telegram no se borra nada (un documento sustituido o perdedor queda como mensaje sin referencia).
CREATE TABLE catalog_prefix_packs (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  pack_id text NOT NULL CHECK (pack_id ~ '^pk-[A-Za-z0-9_-]{8,60}$'),
  generation_id text NOT NULL,
  status text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED', 'PUBLISHED', 'SUPERSEDED', 'FAILED')),
  -- Versión del MAIN que el constructor tomó como base (0 = no había ninguno): la publicación exige que siga siendo la vigente.
  base_seq bigint NOT NULL CHECK (base_seq >= 0),
  seq bigint CHECK (seq > 0),
  random_id text NOT NULL CHECK (random_id ~ '^-?[0-9]{1,20}$'),
  bot_id text NOT NULL,
  chat_id text NOT NULL,
  message_id bigint CHECK (message_id > 0),
  document_id text,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count > 0),
  data_bytes bigint NOT NULL CHECK (data_bytes > 0),
  last_error text CHECK (char_length(last_error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  superseded_at timestamptz,
  PRIMARY KEY (user_id, pack_id),
  UNIQUE (bot_id, random_id),
  -- FAILED puede conservar el message_id de un documento que llegó a existir (huérfano conocido, nunca referenciado).
  CHECK (status NOT IN ('PUBLISHED', 'SUPERSEDED') OR message_id IS NOT NULL),
  CHECK (status <> 'STAGED' OR message_id IS NULL),
  CHECK ((status IN ('PUBLISHED', 'SUPERSEDED')) = (seq IS NOT NULL AND published_at IS NOT NULL)),
  CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX catalog_prefix_packs_seq_idx ON catalog_prefix_packs(user_id, seq) WHERE seq IS NOT NULL;
-- Un único MAIN vigente y una única construcción en curso por biblioteca.
CREATE UNIQUE INDEX catalog_prefix_packs_main_idx ON catalog_prefix_packs(user_id) WHERE status = 'PUBLISHED';
CREATE UNIQUE INDEX catalog_prefix_packs_build_idx ON catalog_prefix_packs(user_id) WHERE status = 'STAGED';

-- Entradas: se registran con el ticket (invisibles hasta PUBLISHED). (file_id, file_sha256) identifica la versión exacta del archivo; el
-- prefijo se valida en el cliente con su propio hash; offset/length son absolutos dentro del documento.
CREATE TABLE catalog_prefix_pack_entries (
  user_id text NOT NULL,
  pack_id text NOT NULL,
  file_id text NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size bigint NOT NULL CHECK (file_size > 0),
  prefix_sha256 text NOT NULL CHECK (prefix_sha256 ~ '^[0-9a-f]{64}$'),
  byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 131072),
  PRIMARY KEY (user_id, pack_id, file_id),
  FOREIGN KEY (user_id, pack_id) REFERENCES catalog_prefix_packs(user_id, pack_id) ON DELETE CASCADE
);

COMMIT;
