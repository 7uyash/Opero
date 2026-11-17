import type { Metadata } from "next";
import { prisma } from "@lfm/db";
import { findWebsiteForm, websiteSettings } from "@lfm/core";
import { HostedForm } from "./hosted-form";

export const metadata: Metadata = { title: "Contact us", robots: { index: false } };

/** Public, embeddable lead form (iframe or direct link). No sign-in. */
export default async function HostedFormPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const form = await findWebsiteForm(key);
  if (!form) {
    return (
      <main className="p-6 text-sm text-muted-foreground">
        This form is no longer accepting submissions.
      </main>
    );
  }
  const settings = websiteSettings(form);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: form.organizationId }, select: { name: true } });
  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <HostedForm
        formKey={key}
        businessName={org.name}
        title={settings.title}
        successMessage={settings.successMessage}
        askCompany={settings.askCompany}
        whatsAppOptInLabel={settings.askWhatsAppOptIn ? settings.whatsAppOptInLabel : null}
      />
    </main>
  );
}
