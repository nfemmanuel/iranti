-- AX-1: normalize existing fact keys (data migration, no schema change).
--
-- Layer 1 normalization (matches the TypeScript normalizeKey in src/library/keys.ts):
--   1. Split optional category: prefix on the first colon.
--   2. Lowercase.
--   3. Collapse runs of non-alphanumeric characters to a single hyphen.
--   4. Trim leading/trailing hyphens.
--
-- camelCase splitting is handled by TypeScript normalizeKey for all new writes;
-- this migration covers the existing dev-store rows which use simple separators.
--
-- Duplicate handling: rows that would collide after normalization are resolved
-- by keeping the most recently updated one and deleting older duplicates.
-- This is safe on the dev store (small, non-production data).

-- Helper: normalize one segment (no colon handling).
CREATE OR REPLACE FUNCTION _iranti_norm_seg(s text) RETURNS text AS $$
  SELECT btrim(lower(regexp_replace(s, '[^a-zA-Z0-9]+', '-', 'g')), '-');
$$ LANGUAGE sql IMMUTABLE;

-- Helper: normalize a full key, handling optional category: prefix.
CREATE OR REPLACE FUNCTION _iranti_norm_key(raw text) RETURNS text AS $$
DECLARE
  col_pos int := position(':' in raw);
  cat     text;
  body    text;
BEGIN
  IF col_pos > 0 THEN
    cat  := _iranti_norm_seg(left(raw, col_pos - 1));
    body := _iranti_norm_seg(substr(raw, col_pos + 1));
    RETURN CASE
      WHEN cat  = '' THEN body
      WHEN body = '' THEN cat
      ELSE cat || ':' || body
    END;
  ELSE
    RETURN _iranti_norm_seg(raw);
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

-- facts: for rows that would share a normalized address, keep the newest.
DELETE FROM facts
WHERE id NOT IN (
  SELECT DISTINCT ON (tenant_id, entity_type, entity_id, _iranti_norm_key(key))
    id
  FROM facts
  ORDER BY
    tenant_id,
    entity_type,
    entity_id,
    _iranti_norm_key(key),
    updated_at DESC NULLS LAST
);
--> statement-breakpoint

-- facts: normalize the key column and stamp rawKey into metadata for changed rows.
UPDATE facts
SET
  key      = _iranti_norm_key(key),
  metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('rawKey', key)
WHERE key != _iranti_norm_key(key);
--> statement-breakpoint

-- fact_archive: no uniqueness constraint — just normalize.
UPDATE fact_archive
SET
  key      = _iranti_norm_key(key),
  metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('rawKey', key)
WHERE key != _iranti_norm_key(key);
--> statement-breakpoint

-- Clean up helpers (idempotent).
DROP FUNCTION IF EXISTS _iranti_norm_seg(text);
DROP FUNCTION IF EXISTS _iranti_norm_key(text);
