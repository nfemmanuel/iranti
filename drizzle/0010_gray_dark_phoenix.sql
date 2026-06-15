-- CORE-16: enable pgvector extension.
-- Requires the pgvector/pgvector:pg17 Docker image (see docker-compose.yml).
-- If the extension is unavailable, this migration will fail with
-- "extension 'vector' is not available" — switch the image and restart: pnpm db:down && pnpm db:up
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "embedding" vector(768);--> statement-breakpoint
CREATE INDEX "facts_embedding_hnsw_idx" ON "facts" USING hnsw ("embedding" vector_cosine_ops);