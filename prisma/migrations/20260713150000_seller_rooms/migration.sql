-- CreateEnum
CREATE TYPE "SellerRoomStatus" AS ENUM ('OPEN', 'ACTIVE', 'ENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SellerRoomMemberStatus" AS ENUM ('INVITED', 'JOINED', 'LEFT');

-- CreateEnum
CREATE TYPE "SellerRoomInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "SellerRoom" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SellerRoomStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "meetUrl" TEXT,
    "metadata" JSONB,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerRoomMember" (
    "id" TEXT NOT NULL,
    "sellerRoomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SellerRoomMemberStatus" NOT NULL DEFAULT 'INVITED',
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerRoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerRoomInvitation" (
    "id" TEXT NOT NULL,
    "sellerRoomId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" "SellerRoomInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerRoomInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerRoom_tenantId_status_idx" ON "SellerRoom"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SellerRoom_tenantId_meetingId_idx" ON "SellerRoom"("tenantId", "meetingId");

-- CreateIndex
CREATE INDEX "SellerRoom_createdById_idx" ON "SellerRoom"("createdById");

-- CreateIndex
CREATE INDEX "SellerRoomMember_userId_idx" ON "SellerRoomMember"("userId");

-- CreateIndex
CREATE INDEX "SellerRoomMember_sellerRoomId_status_idx" ON "SellerRoomMember"("sellerRoomId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SellerRoomMember_sellerRoomId_userId_key" ON "SellerRoomMember"("sellerRoomId", "userId");

-- CreateIndex
CREATE INDEX "SellerRoomInvitation_sellerRoomId_status_idx" ON "SellerRoomInvitation"("sellerRoomId", "status");

-- CreateIndex
CREATE INDEX "SellerRoomInvitation_inviteeId_status_idx" ON "SellerRoomInvitation"("inviteeId", "status");

-- AddForeignKey
ALTER TABLE "SellerRoom" ADD CONSTRAINT "SellerRoom_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerRoom" ADD CONSTRAINT "SellerRoom_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerRoomMember" ADD CONSTRAINT "SellerRoomMember_sellerRoomId_fkey" FOREIGN KEY ("sellerRoomId") REFERENCES "SellerRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerRoomMember" ADD CONSTRAINT "SellerRoomMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerRoomInvitation" ADD CONSTRAINT "SellerRoomInvitation_sellerRoomId_fkey" FOREIGN KEY ("sellerRoomId") REFERENCES "SellerRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerRoomInvitation" ADD CONSTRAINT "SellerRoomInvitation_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerRoomInvitation" ADD CONSTRAINT "SellerRoomInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
