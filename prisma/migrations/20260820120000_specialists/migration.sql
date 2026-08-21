-- CreateEnum
CREATE TYPE "SpecialistStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SpecialistSource" AS ENUM ('CODE', 'CUSTOM');

-- CreateTable
CREATE TABLE "SpecialistTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT '',
    "exampleMessage" TEXT NOT NULL DEFAULT '',
    "triggerPhases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "cooldownSec" INTEGER NOT NULL DEFAULT 15,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "model" TEXT NOT NULL DEFAULT 'gemini-2.5-flash',
    "maxLatencyMs" INTEGER NOT NULL DEFAULT 4000,
    "status" "SpecialistStatus" NOT NULL DEFAULT 'DRAFT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" "SpecialistSource" NOT NULL DEFAULT 'CUSTOM',
    "icon" TEXT,
    "color" TEXT,
    "lastDryRunAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialistVersion" (
    "id" TEXT NOT NULL,
    "specialistId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecialistVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSpecialistPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "specialistKeys" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSpecialistPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpecialistTemplate_key_key" ON "SpecialistTemplate"("key");

-- CreateIndex
CREATE INDEX "SpecialistTemplate_status_enabled_idx" ON "SpecialistTemplate"("status", "enabled");

-- CreateIndex
CREATE INDEX "SpecialistTemplate_source_idx" ON "SpecialistTemplate"("source");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialistVersion_specialistId_version_key" ON "SpecialistVersion"("specialistId", "version");

-- CreateIndex
CREATE INDEX "SpecialistVersion_specialistId_idx" ON "SpecialistVersion"("specialistId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSpecialistPreference_userId_tenantId_key" ON "UserSpecialistPreference"("userId", "tenantId");

-- CreateIndex
CREATE INDEX "UserSpecialistPreference_tenantId_idx" ON "UserSpecialistPreference"("tenantId");

-- AddForeignKey
ALTER TABLE "SpecialistVersion" ADD CONSTRAINT "SpecialistVersion_specialistId_fkey" FOREIGN KEY ("specialistId") REFERENCES "SpecialistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSpecialistPreference" ADD CONSTRAINT "UserSpecialistPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSpecialistPreference" ADD CONSTRAINT "UserSpecialistPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
