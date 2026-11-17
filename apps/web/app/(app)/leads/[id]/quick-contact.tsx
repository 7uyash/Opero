import { Mail, MessageCircle, Phone } from "lucide-react";

/**
 * One-tap contact buttons. On a phone these open the dialer, WhatsApp or the mail app.
 * (Log the conversation afterwards with "I contacted them" so the follow-ups re-time.)
 */
export function QuickContact({ phone, email }: { phone: string | null; email: string | null }) {
  if (!phone && !email) return null;
  const digits = phone?.replace(/\D/g, "");
  const btn =
    "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted md:h-9 md:flex-none";
  return (
    <div className="flex w-full gap-2 md:w-auto" aria-label="Contact the customer">
      {phone && (
        <a href={`tel:${phone}`} className={btn}>
          <Phone className="size-4" aria-hidden /> Call
        </a>
      )}
      {digits && (
        <a href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer" className={btn}>
          <MessageCircle className="size-4" aria-hidden /> WhatsApp
        </a>
      )}
      {email && (
        <a href={`mailto:${email}`} className={btn}>
          <Mail className="size-4" aria-hidden /> Email
        </a>
      )}
    </div>
  );
}
