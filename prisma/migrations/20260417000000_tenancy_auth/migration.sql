-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'SERVICE');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- Seed default tenant so legacy rows can be backfilled
INSERT INTO "Tenant" ("id", "slug", "name", "status", "createdAt", "updatedAt")
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'default',
    'Default Tenant',
    'ACTIVE',
    NOW(),
    NOW()
) ON CONFLICT DO NOTHING;

-- AlterTable User: backfill tenantId + add auth fields
ALTER TABLE "User" ADD COLUMN     "tenantId" TEXT;
UPDATE "User" SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
ALTER TABLE "User" ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'MEMBER';
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- Replace global unique(email) with composite (tenantId, email)
DROP INDEX IF EXISTS "User_email_key";
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable Session
ALTER TABLE "Session" ADD COLUMN     "tenantId" TEXT;
UPDATE "Session" SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
ALTER TABLE "Session" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX IF EXISTS "Session_meetingId_key";
CREATE UNIQUE INDEX "Session_tenantId_meetingId_key" ON "Session"("tenantId", "meetingId");
CREATE INDEX "Session_tenantId_idx" ON "Session"("tenantId");

ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable FeedbackEvent
ALTER TABLE "FeedbackEvent" ADD COLUMN     "tenantId" TEXT;
UPDATE "FeedbackEvent" SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
ALTER TABLE "FeedbackEvent" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX IF EXISTS "FeedbackEvent_meetingId_ts_idx";
CREATE INDEX "FeedbackEvent_tenantId_meetingId_ts_idx" ON "FeedbackEvent"("tenantId", "meetingId", "ts");

ALTER TABLE "FeedbackEvent" ADD CONSTRAINT "FeedbackEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable RefreshToken
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "createdByIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_tenantId_userId_idx" ON "RefreshToken"("tenantId", "userId");
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable AuditLog
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
