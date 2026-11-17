-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "failureKind" TEXT,
ADD COLUMN     "integrationId" TEXT,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "messages_status_scheduledFor_idx" ON "messages"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "notifications_emailPending_idx" ON "notifications"("emailPending");
