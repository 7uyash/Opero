import { LEAD_STATUS_LABELS, PRIORITY_LABELS, type LeadPriority, type LeadStatus } from "@lfm/shared";
import { Badge } from "@/components/ui/badge";

const STATUS_TONE: Record<LeadStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  NEW: "info",
  ASSIGNED: "info",
  CONTACTED: "neutral",
  WAITING_FOR_CUSTOMER: "neutral",
  FOLLOW_UP_DUE: "warning",
  QUALIFIED: "success",
  CONVERTED: "success",
  LOST: "danger",
  ON_HOLD: "neutral",
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{LEAD_STATUS_LABELS[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: LeadPriority }) {
  if (priority === "NORMAL") return null;
  return <Badge tone={priority === "URGENT" ? "danger" : priority === "HIGH" ? "warning" : "neutral"}>{PRIORITY_LABELS[priority]}</Badge>;
}
