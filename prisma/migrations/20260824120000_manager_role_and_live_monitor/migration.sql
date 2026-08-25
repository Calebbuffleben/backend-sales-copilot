-- MembershipRole: gestor da conta (Live Floor / War Room / whisper).
DO $$ BEGIN
  ALTER TYPE "MembershipRole" ADD VALUE 'MANAGER';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- FeedbackEvent type for gestor → vendedor whisper.
DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'manager_whisper';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Session.userId so Live Floor cards can show the rep name.
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "userId" TEXT;

CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");

DO $$ BEGIN
  ALTER TABLE "Session"
    ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MonitorAlertKind" AS ENUM ('red', 'yellow', 'sos');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "MonitorAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" "MonitorAlertKind" NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MonitorAlert_tenantId_meetingId_createdAt_idx"
  ON "MonitorAlert"("tenantId", "meetingId", "createdAt");

CREATE INDEX IF NOT EXISTS "MonitorAlert_tenantId_acknowledgedAt_idx"
  ON "MonitorAlert"("tenantId", "acknowledgedAt");

DO $$ BEGIN
  ALTER TABLE "MonitorAlert"
    ADD CONSTRAINT "MonitorAlert_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MonitorAlert"
    ADD CONSTRAINT "MonitorAlert_acknowledgedBy_fkey"
    FOREIGN KEY ("acknowledgedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
