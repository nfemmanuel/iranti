-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('bug', 'praise', 'suggestion', 'general');

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "feedback_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "type" "FeedbackType" NOT NULL,
    "version" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "node_version" TEXT NOT NULL,
    "session_count" INTEGER,
    "fact_count" INTEGER,
    "instance_id" TEXT NOT NULL,
    "milestone_context" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feedback_feedback_id_key" ON "feedback"("feedback_id");

-- CreateIndex
CREATE INDEX "feedback_instance_id_idx" ON "feedback"("instance_id");

-- CreateIndex
CREATE INDEX "feedback_received_at_idx" ON "feedback"("received_at");

-- CreateIndex
CREATE INDEX "feedback_rating_idx" ON "feedback"("rating");
