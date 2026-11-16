-- CreateTable
CREATE TABLE "TranscriptTurn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "speaker" TEXT NOT NULL,
    "textEn" TEXT NOT NULL,
    "textPt" TEXT NOT NULL,
    "summaryPt" TEXT NOT NULL DEFAULT '',
    "seq" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingRecap" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "decisions" JSONB NOT NULL,
    "highlights" JSONB NOT NULL,
    "actionItems" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingRecap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TranscriptTurn_tenantId_meetingId_seq_idx" ON "TranscriptTurn"("tenantId", "meetingId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptTurn_tenantId_meetingId_turnId_key" ON "TranscriptTurn"("tenantId", "meetingId", "turnId");

-- CreateIndex
CREATE INDEX "MeetingRecap_tenantId_idx" ON "MeetingRecap"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRecap_tenantId_meetingId_key" ON "MeetingRecap"("tenantId", "meetingId");

-- AddForeignKey
ALTER TABLE "TranscriptTurn" ADD CONSTRAINT "TranscriptTurn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecap" ADD CONSTRAINT "MeetingRecap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
