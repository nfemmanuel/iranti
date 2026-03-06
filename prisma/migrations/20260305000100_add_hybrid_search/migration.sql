CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "knowledge_base"
ADD COLUMN "embedding" vector(256);

CREATE INDEX "knowledge_base_embedding_ivfflat_idx"
ON "knowledge_base"
USING ivfflat ("embedding" vector_cosine_ops)
WITH (lists = 100);

CREATE INDEX "knowledge_base_textsearch_idx"
ON "knowledge_base"
USING GIN (to_tsvector('english', coalesce("key", '') || ' ' || coalesce("valueSummary", '')));
