-- AX-2: extraction_cache table
--
-- Durable content-hash cache for the LLM extractor. Composite PK is the
-- cache key: (tenant_id, input_hash, regime_signature). Entries are
-- permanent — busted only by a regime change (model/prompt/normalizer version).

CREATE TABLE IF NOT EXISTS "extraction_cache" (
  "tenant_id"         text NOT NULL DEFAULT 'default',
  "input_hash"        text NOT NULL,
  "regime_signature"  text NOT NULL,
  "result"            jsonb NOT NULL,
  "extractor_mode"    text NOT NULL,
  "model_id"          text NOT NULL,
  "prompt_version"    text NOT NULL,
  "normalizer_version" text NOT NULL,
  "hit_count"         integer NOT NULL DEFAULT 0,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "last_hit_at"       timestamptz,
  CONSTRAINT "extraction_cache_pk"
    PRIMARY KEY ("tenant_id", "input_hash", "regime_signature")
);
