-- AlterTable
ALTER TABLE "Session" ADD COLUMN "activeConnections" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "audioSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Session" ADD COLUMN "metadata" JSONB;

-- CreateTable
CREATE TABLE "OperationalEvent" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "tenantId" TEXT,
    "meetingId" TEXT,
    "userId" TEXT,
    "participantId" TEXT,
    "traceId" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "durationMs" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "OperationalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageDailyAggregate" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    "meetingsCount" INTEGER NOT NULL DEFAULT 0,
    "audioSeconds" INTEGER NOT NULL DEFAULT 0,
    "transcriptionWindows" INTEGER NOT NULL DEFAULT 0,
    "feedbacksCount" INTEGER NOT NULL DEFAULT 0,
    "geminiRequests" INTEGER NOT NULL DEFAULT 0,
    "geminiEstimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "assemblyAiSeconds" INTEGER NOT NULL DEFAULT 0,
    "assemblyAiEstimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageDailyAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_tenantId_status_lastSeenAt_idx" ON "Session"("tenantId", "status", "lastSeenAt");
CREATE INDEX "OperationalEvent_tenantId_timestamp_idx" ON "OperationalEvent"("tenantId", "timestamp");
CREATE INDEX "OperationalEvent_meetingId_timestamp_idx" ON "OperationalEvent"("meetingId", "timestamp");
CREATE INDEX "OperationalEvent_userId_timestamp_idx" ON "OperationalEvent"("userId", "timestamp");
CREATE INDEX "OperationalEvent_traceId_idx" ON "OperationalEvent"("traceId");
CREATE INDEX "OperationalEvent_stage_timestamp_idx" ON "OperationalEvent"("stage", "timestamp");
CREATE UNIQUE INDEX "UsageDailyAggregate_date_tenantId_key" ON "UsageDailyAggregate"("date", "tenantId");
CREATE INDEX "UsageDailyAggregate_tenantId_date_idx" ON "UsageDailyAggregate"("tenantId", "date");
