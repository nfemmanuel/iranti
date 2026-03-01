-- AlterTable
ALTER TABLE "archive" ADD COLUMN     "supersededByEntityId" TEXT,
ADD COLUMN     "supersededByEntityType" TEXT,
ADD COLUMN     "supersededByKey" TEXT;
