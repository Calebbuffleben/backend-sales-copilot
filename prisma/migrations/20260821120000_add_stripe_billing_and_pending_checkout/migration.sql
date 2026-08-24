-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "stripeCustomerId" TEXT,
ADD COLUMN "stripeSubscriptionId" TEXT,
ADD COLUMN "stripePriceId" TEXT,
ADD COLUMN "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Subscription_stripeCustomerId_key" ON "Subscription"("stripeCustomerId");
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateEnum
CREATE TYPE "PendingCheckoutStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PendingCheckout" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "tenantName" TEXT NOT NULL,
    "tenantSlug" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "stripeCheckoutSessionId" TEXT,
    "status" "PendingCheckoutStatus" NOT NULL DEFAULT 'PENDING',
    "tenantId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingCheckout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingCheckout_stripeCheckoutSessionId_key" ON "PendingCheckout"("stripeCheckoutSessionId");
CREATE INDEX "PendingCheckout_email_status_idx" ON "PendingCheckout"("email", "status");
CREATE INDEX "PendingCheckout_status_createdAt_idx" ON "PendingCheckout"("status", "createdAt");
