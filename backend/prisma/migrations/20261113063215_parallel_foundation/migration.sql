-- AlterTable
ALTER TABLE "ActionItem" ADD COLUMN     "assignedBy" TEXT,
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "dueSpoken" TEXT,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "hints" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "roster" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'AUTO',
ADD COLUMN     "processingError" TEXT,
ADD COLUMN     "processingProgress" INTEGER,
ADD COLUMN     "processingStage" TEXT;

-- AlterTable
ALTER TABLE "TranscriptSegment" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "noiseLabel" TEXT,
ADD COLUMN     "speakerId" TEXT,
ADD COLUMN     "words" JSONB;

-- CreateTable
CREATE TABLE "SpeakerProfile" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "displayName" TEXT,
    "centroid" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "source" TEXT NOT NULL DEFAULT 'DIARIZATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpeakerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Correction" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Correction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveChunk" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "startOffsetMs" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "channelLayout" TEXT NOT NULL DEFAULT 'mono',
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "segmentCount" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpeakerProfile_meetingId_label_key" ON "SpeakerProfile"("meetingId", "label");

-- CreateIndex
CREATE INDEX "Correction_meetingId_createdAt_idx" ON "Correction"("meetingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LiveChunk_sessionId_seq_key" ON "LiveChunk"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "TranscriptSegment_speakerId_idx" ON "TranscriptSegment"("speakerId");

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_speakerId_fkey" FOREIGN KEY ("speakerId") REFERENCES "SpeakerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpeakerProfile" ADD CONSTRAINT "SpeakerProfile_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveChunk" ADD CONSTRAINT "LiveChunk_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
