import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

const styles = {
  error: { box: "border-destructive/30 bg-destructive-soft text-destructive", Icon: AlertCircle },
  success: { box: "border-success/30 bg-success-soft text-success", Icon: CheckCircle2 },
  info: { box: "border-border bg-muted text-foreground", Icon: Info },
} as const;

export function Alert({ tone = "info", children }: { tone?: keyof typeof styles; children: ReactNode }) {
  const { box, Icon } = styles[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex gap-2 rounded-md border p-3 text-sm", box)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
