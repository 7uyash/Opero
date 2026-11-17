import { listIntegrations, missingEnv, type OrgContext } from "@lfm/core";
import { PROVIDER_CATALOG, type ProviderKey } from "@lfm/shared";
import { serverBaseUrl } from "@/lib/base-url";
import { getOrganization } from "@/lib/session";
import { GmailCard, HubSpotCard, MetaLeadsCard, WhatsAppCard, type ProviderState } from "./provider-cards";
import { SmtpCard } from "./smtp-card";
import { WebsiteFormsCard } from "./website-forms-card";

/** Loads connection state and renders the cards for the given providers (in that order). */
export async function IntegrationCards({ ctx, userEmail, providers }: { ctx: OrgContext; userEmail: string; providers: ProviderKey[] }) {
  const [integrations, org, baseUrl] = await Promise.all([listIntegrations(ctx), getOrganization(ctx.organizationId), serverBaseUrl()]);
  const latest = (provider: string): ProviderState => {
    const i = [...integrations].reverse().find((x) => x.provider === provider);
    return i
      ? { id: i.id, status: i.status, name: i.name, lastError: i.lastError, lastTestedAt: i.lastTestedAt?.toISOString() ?? null, config: i.config as Record<string, unknown> }
      : null;
  };
  const env = (p: ProviderKey) => missingEnv(PROVIDER_CATALOG[p].requiresEnv);

  return (
    <>
      {providers.map((p) => {
        switch (p) {
          case "WEBSITE_FORM":
            return (
              <WebsiteFormsCard
                key={p}
                baseUrl={baseUrl}
                forms={integrations
                  .filter((i) => i.provider === "WEBSITE_FORM")
                  .map((i) => ({
                    id: i.id,
                    name: i.name,
                    status: i.status,
                    webhookKey: i.webhookKey ?? "",
                    allowedOrigins: ((i.config as { allowedOrigins?: string[] }).allowedOrigins ?? []) as string[],
                    lastError: i.lastError,
                  }))}
              />
            );
          case "META_LEAD_ADS":
            return <MetaLeadsCard key={p} state={latest(p)} baseUrl={baseUrl} missingEnv={env(p)} />;
          case "HUBSPOT":
            return <HubSpotCard key={p} state={latest(p)} />;
          case "GMAIL":
            return <GmailCard key={p} state={latest(p)} baseUrl={baseUrl} missingEnv={env(p)} />;
          case "WHATSAPP_CLOUD":
            return <WhatsAppCard key={p} state={latest(p)} baseUrl={baseUrl} missingEnv={env(p)} />;
          case "SMTP": {
            const s = latest("SMTP");
            return (
              <SmtpCard
                key={p}
                integration={s && { id: s.id, status: s.status, lastError: s.lastError, lastTestedAt: s.lastTestedAt, config: s.config as Record<string, string | number | boolean> }}
                defaults={{ fromEmail: org.email, fromName: org.name }}
                myEmail={userEmail}
              />
            );
          }
        }
      })}
    </>
  );
}
