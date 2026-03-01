-- CreateTable
CREATE TABLE "write_receipts" (
    "id" SERIAL NOT NULL,
    "requestId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "resultEntryId" INTEGER,
    "escalationFile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "write_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "write_receipts_requestId_key" ON "write_receipts"("requestId");

-- CreateIndex
CREATE INDEX "write_receipts_entityType_entityId_key_idx" ON "write_receipts"("entityType", "entityId", "key");
