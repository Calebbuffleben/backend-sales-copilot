-- CreateTable
CREATE TABLE "PlaybookTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaybookTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaybookTemplate_tenantId_key_key" ON "PlaybookTemplate"("tenantId", "key");

-- CreateIndex
CREATE INDEX "PlaybookTemplate_tenantId_idx" ON "PlaybookTemplate"("tenantId");

-- AddForeignKey
ALTER TABLE "PlaybookTemplate" ADD CONSTRAINT "PlaybookTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
