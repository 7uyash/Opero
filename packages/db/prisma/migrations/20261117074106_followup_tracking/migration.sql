-- AlterTable
ALTER TABLE "follow_up_tasks" ADD COLUMN     "overdueNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "followUpStep" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "follow_up_tasks_organizationId_leadId_status_idx" ON "follow_up_tasks"("organizationId", "leadId", "status");
