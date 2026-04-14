/*
  Warnings:

  - A unique constraint covering the columns `[userId,entityType,entityId,key]` on the table `knowledge_base` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "Surface" AS ENUM ('claude', 'chatgpt', 'gemini', 'deepseek', 'dev_cli', 'web_ui', 'manual');

-- CreateEnum
CREATE TYPE "TokenScope" AS ENUM ('dev_cli', 'mcp_consumer_t0', 'mcp_consumer_oauth', 'pairing_temp');

-- DropIndex
DROP INDEX "knowledge_base_embedding_ivfflat_idx";

-- DropIndex
DROP INDEX "knowledge_base_entityType_entityId_key_idx";

-- DropIndex
DROP INDEX "knowledge_base_entityType_entityId_key_key";

-- DropIndex
DROP INDEX "staff_events_agent_id_timestamp_idx";

-- DropIndex
DROP INDEX "staff_events_entity_lookup_idx";

-- DropIndex
DROP INDEX "staff_events_level_timestamp_idx";

-- DropIndex
DROP INDEX "staff_events_source_timestamp_idx";

-- DropIndex
DROP INDEX "staff_events_timestamp_idx";

-- AlterTable
ALTER TABLE "knowledge_base" ADD COLUMN     "surface" "Surface",
ADD COLUMN     "userId" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedInto" INTEGER,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Seed: default local user (id=1) — backwards-compat for all existing single-tenant rows
INSERT INTO "users" ("id", "email", "createdAt") VALUES (1, NULL, CURRENT_TIMESTAMP);
SELECT setval(pg_get_serial_sequence('"users"', 'id'), 1);

-- CreateTable
CREATE TABLE "tokens" (
    "id" SERIAL NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "scope" "TokenScope" NOT NULL,
    "surface" "Surface" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_tokenHash_key" ON "tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "tokens_userId_idx" ON "tokens"("userId");

-- CreateIndex
CREATE INDEX "knowledge_base_userId_entityType_entityId_key_idx" ON "knowledge_base"("userId", "entityType", "entityId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_userId_entityType_entityId_key_key" ON "knowledge_base"("userId", "entityType", "entityId", "key");

-- CreateIndex
CREATE INDEX "staff_events_timestamp_idx" ON "staff_events"("timestamp");

-- CreateIndex
CREATE INDEX "staff_events_agent_id_timestamp_idx" ON "staff_events"("agent_id", "timestamp");

-- CreateIndex
CREATE INDEX "staff_events_source_timestamp_idx" ON "staff_events"("source", "timestamp");

-- CreateIndex
CREATE INDEX "staff_events_level_timestamp_idx" ON "staff_events"("level", "timestamp");

-- CreateIndex
CREATE INDEX "staff_events_entity_type_entity_id_key_timestamp_idx" ON "staff_events"("entity_type", "entity_id", "key", "timestamp");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_mergedInto_fkey" FOREIGN KEY ("mergedInto") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
