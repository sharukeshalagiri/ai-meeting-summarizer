-- Adds structured summary storage.
--
-- `updatedAt` was present in schema.prisma but had never been applied
-- to the database, so it is added here. Existing rows are backfilled
-- from `createdAt` instead of failing on a NOT NULL column with no
-- default.

-- DropForeignKey
ALTER TABLE "Summary" DROP CONSTRAINT "Summary_meetingId_fkey";

-- AlterTable: structured payload, null for pre-existing summaries
ALTER TABLE "Summary" ADD COLUMN "data" JSONB;

-- AlterTable: add updatedAt in three steps so existing rows survive
ALTER TABLE "Summary" ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "Summary" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

ALTER TABLE "Summary" ALTER COLUMN "updatedAt" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Summary" ADD CONSTRAINT "Summary_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
