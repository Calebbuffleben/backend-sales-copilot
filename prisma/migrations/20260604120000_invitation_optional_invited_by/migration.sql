-- Platform-bootstrap owner invites may have no inviter user yet.
ALTER TABLE "Invitation" ALTER COLUMN "invitedById" DROP NOT NULL;

-- Align FK with optional inviter (platform-created tenant owner invites).
ALTER TABLE "Invitation" DROP CONSTRAINT IF EXISTS "Invitation_invitedById_fkey";
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
