"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type IntegrationStatus = "NOT_CONNECTED" | "PENDING" | "CONNECTED" | "ERROR" | "DISCONNECTED";

const STATUS: Record<IntegrationStatus, { label: string; tone: "success" | "danger" | "neutral" | "warning" }> = {
  CONNECTED: { label: "Connected", tone: "success" },
  ERROR: { label: "Needs attention", tone: "danger" },
  DISCONNECTED: { label: "Disconnected", tone: "neutral" },
  NOT_CONNECTED: { label: "Not connected", tone: "neutral" },
  PENDING: { label: "Waiting for first use", tone: "warning" },
};

export function IntegrationShell({
  title,
  description,
  status,
  statusLabel,
  icon,
  children,
}: {
  title: string;
  description: string;
  status: IntegrationStatus;
  statusLabel?: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const s = STATUS[status];
  return (
    <Card>
      <CardHeader className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between sm:gap-4">
        <div className="flex gap-3">
          <span className="mt-1 text-muted-foreground">{icon}</span>
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
        <Badge tone={s.tone} className="shrink-0">{statusLabel ?? s.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/** Read-only value with a copy button (URLs, snippets, secrets). */
export function CopyField({ label, value, multiline, secret }: { label: string; value: string; multiline?: boolean; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {multiline ? (
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap">{value}</pre>
      ) : (
        <input
          readOnly
          aria-label={label}
          value={value}
          type={secret ? "text" : "text"}
          onFocus={(e) => e.target.select()}
          className="h-9 w-full rounded-md border border-border bg-muted px-3 font-mono text-xs"
        />
      )}
    </div>
  );
}

/** Shown when the self-hosting administrator hasn't configured the provider's app yet. */
export function RequiresSetup({ missing, docs }: { missing: string[]; docs: string }) {
  return (
    <div className="rounded-md border border-border bg-muted p-3 text-sm">
      <p className="font-medium">Requires setup by your administrator</p>
      <p className="mt-1 text-muted-foreground">
        This server is missing {missing.join(", ")}. {docs}
      </p>
    </div>
  );
}
