-- Align production databases with the current auth model:
-- User is a global identity; Membership is the tenant-scoped permission anchor.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELED', 'PAST_DUE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "invitedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- Backfill memberships from the previous tenant-scoped User model.
INSERT INTO "Membership" ("id", "userId", "tenantId", "role", "invitedBy", "createdAt", "updatedAt")
SELECT
    md5(random()::text || clock_timestamp()::text),
    "id",
    "tenantId",
    CASE
        WHEN "role"::text = 'OWNER' THEN 'OWNER'::"MembershipRole"
        WHEN "role"::text = 'ADMIN' THEN 'ADMIN'::"MembershipRole"
        ELSE 'MEMBER'::"MembershipRole"
    END,
    NULL,
    COALESCE("createdAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
FROM "User"
WHERE "tenantId" IS NOT NULL
AND NOT EXISTS (
    SELECT 1
    FROM "Membership"
    WHERE "Membership"."userId" = "User"."id"
      AND "Membership"."tenantId" = "User"."tenantId"
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_userId_tenantId_key" ON "Membership"("userId", "tenantId");
CREATE INDEX IF NOT EXISTS "Membership_tenantId_idx" ON "Membership"("tenantId");
CREATE INDEX IF NOT EXISTS "Membership_userId_idx" ON "Membership"("userId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Subscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "maxUsers" INTEGER NOT NULL DEFAULT 3,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Subscription" ("id", "tenantId", "plan", "maxUsers", "status", "createdAt", "updatedAt")
SELECT
    md5(random()::text || clock_timestamp()::text),
    "id",
    'FREE'::"Plan",
    3,
    'ACTIVE'::"SubscriptionStatus",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Tenant"
WHERE NOT EXISTS (
    SELECT 1
    FROM "Subscription"
    WHERE "Subscription"."tenantId" = "Tenant"."id"
);

CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_tenantId_key" ON "Subscription"("tenantId");
CREATE INDEX IF NOT EXISTS "Subscription_tenantId_idx" ON "Subscription"("tenantId");

DO $$ BEGIN
    ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "Invitation_tenantId_status_idx" ON "Invitation"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Invitation_tenantId_email_idx" ON "Invitation"("tenantId", "email");
CREATE INDEX IF NOT EXISTS "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

DO $$ BEGIN
    ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- RefreshToken gained membershipId in the current schema.
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "membershipId" TEXT;

-- Convert User back to a global identity.
DROP INDEX IF EXISTS "User_tenantId_email_key";
DROP INDEX IF EXISTS "User_tenantId_idx";

DO $$ BEGIN
    ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_tenantId_fkey";
END $$;

-- This can fail if the legacy database contains duplicate emails across tenants.
-- The current app contract requires global unique emails; resolve duplicates before deploying if needed.
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

ALTER TABLE "User" DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "role";

DROP TYPE IF EXISTS "UserRole";
