import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@lfm/core";
import { Alert } from "@/components/ui/alert";
import { requireAuth } from "@/lib/session";
import { IntegrationCards } from "./integration-cards";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const { session, ctx } = await requireAuth();
  if (!can(ctx, "integrations:manage")) notFound();
  const sp = await searchParams;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect where your leads come from and how you talk to customers. A connection only shows as connected after it has been tested successfully.
        </p>
      </header>
      {sp.connected && <Alert tone="success">Connected. {sp.connected === "meta" ? "Now choose the Page that runs your lead ads." : ""}</Alert>}
      {sp.error && <Alert tone="error">{sp.error}</Alert>}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Where leads come from</h2>
        <IntegrationCards ctx={ctx} userEmail={session.user.email} providers={["WEBSITE_FORM", "META_LEAD_ADS", "HUBSPOT"]} />
      </section>
      <section className="space-y-4">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Talking to customers</h2>
        <IntegrationCards ctx={ctx} userEmail={session.user.email} providers={["GMAIL", "SMTP", "WHATSAPP_CLOUD"]} />
      </section>
    </div>
  );
}
