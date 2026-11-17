import {
  ArrowRightLeft,
  CalendarClock,
  CheckCircle2,
  PauseCircle,
  Circle,
  Copy,
  MessageSquare,
  PhoneCall,
  Send,
  StickyNote,
  UserPlus,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  INTERACTION_CHANNEL_LABELS,
  LEAD_STATUS_LABELS,
  SOURCE_LABELS,
  type LeadStatus,
  type SourceType,
} from "@lfm/shared";
import { formatDateTime } from "@/lib/format";

type Entry = {
  id: string;
  type: string;
  actorType: string;
  actorName: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
};

const s = (v: unknown) => (typeof v === "string" ? v : "");
const channelName = (c: unknown) => (c === "EMAIL" ? "Email" : c === "WHATSAPP" ? "WhatsApp" : "message");
const PURPOSE_LABELS: Record<string, string> = {
  acknowledgement: "Acknowledgement",
  follow_up: "Follow-up message",
  fallback: "Fallback message",
  manual: "Message",
};

function describe(e: Entry): { icon: LucideIcon; title: string; body?: string } {
  const p = e.payload;
  switch (e.type) {
    case "LEAD_CREATED":
      return { icon: Circle, title: `Lead received from ${SOURCE_LABELS[p.source as SourceType] ?? "a source"}`, body: s(p.subject) };
    case "DUPLICATE_MERGED":
      return {
        icon: Copy,
        title: `Same customer contacted again via ${SOURCE_LABELS[p.source as SourceType] ?? "another source"}`,
        body: [s(p.subject), s(p.inquiry)].filter(Boolean).join(" — "),
      };
    case "ASSIGNED":
      return { icon: UserPlus, title: `Assigned to ${s(p.memberName) || "a team member"}${p.method === "ROUND_ROBIN" ? " automatically" : ""}` };
    case "REASSIGNED":
      return { icon: ArrowRightLeft, title: `Reassigned to ${s(p.memberName) || "a team member"}`, body: s(p.reason) };
    case "UNASSIGNED":
      return { icon: ArrowRightLeft, title: "Moved to the unassigned queue", body: s(p.reason) };
    case "STATUS_CHANGED":
      return {
        icon: ArrowRightLeft,
        title: `Status changed from ${LEAD_STATUS_LABELS[p.from as LeadStatus] ?? p.from} to ${LEAD_STATUS_LABELS[p.to as LeadStatus] ?? p.to}`,
        body: s(p.reason),
      };
    case "CONVERTED":
      return { icon: CheckCircle2, title: "Marked as converted" };
    case "LOST":
      return { icon: XCircle, title: "Marked as lost", body: s(p.reason) };
    case "NOTE_ADDED":
      return { icon: StickyNote, title: "Note", body: s(p.body) };
    case "EMPLOYEE_CONTACTED":
      return {
        icon: PhoneCall,
        title: `Contacted the customer by ${(INTERACTION_CHANNEL_LABELS as Record<string, string>)[s(p.channel)]?.toLowerCase() ?? "other means"}`,
        body: s(p.note),
      };
    case "CUSTOMER_REPLIED":
      return { icon: MessageSquare, title: "Customer replied", body: s(p.preview) };
    case "FOLLOW_UP_SCHEDULED": {
      if (p.manual) return { icon: CalendarClock, title: `Follow-up scheduled: ${s(p.title)}`, body: s(p.note) };
      if (p.rescheduled) return { icon: CalendarClock, title: `Follow-up rescheduled: ${s(p.title)}` };
      const count = typeof p.count === "number" ? p.count : 0;
      return { icon: CalendarClock, title: `${count} follow-up reminder${count === 1 ? "" : "s"} scheduled`, body: s(p.reason) };
    }
    case "FOLLOW_UP_COMPLETED":
      return { icon: CheckCircle2, title: `Follow-up done: ${s(p.title) || "reminder"}`, body: s(p.note) };
    case "FOLLOW_UP_SKIPPED":
      return { icon: Circle, title: `Follow-up skipped: ${s(p.title) || "reminder"}`, body: s(p.reason) };
    case "FOLLOW_UPS_PAUSED":
      return { icon: PauseCircle, title: "Automatic follow-ups paused", body: s(p.reason) };
    case "FOLLOW_UPS_STOPPED":
      return { icon: XCircle, title: "Follow-ups stopped", body: s(p.reason) };
    case "LEAD_UPDATED":
      return { icon: Circle, title: "Customer details updated", body: Array.isArray(p.fields) ? `Changed: ${p.fields.join(", ")}` : undefined };
    case "MESSAGE_QUEUED":
      return { icon: Send, title: `${PURPOSE_LABELS[s(p.purpose)] ?? "Message"} queued (${channelName(p.channel)})`, body: s(p.preview) };
    case "MESSAGE_SENT":
      return { icon: Send, title: `${PURPOSE_LABELS[s(p.purpose)] ?? "Message"} sent by ${channelName(p.channel)}`, body: s(p.subject) || s(p.preview) };
    case "MESSAGE_DELIVERED":
      return { icon: CheckCircle2, title: `Message delivered (${channelName(p.channel)})` };
    case "MESSAGE_FAILED":
      return { icon: XCircle, title: `${PURPOSE_LABELS[s(p.purpose)] ?? "Message"} failed (${channelName(p.channel)})`, body: s(p.error) };
    case "OPTED_OUT":
      return { icon: XCircle, title: `Customer opted out of ${channelName(p.channel).toLowerCase()}` };
    default:
      return { icon: Circle, title: e.type.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) };
  }
}

export function Timeline({ entries, timeZone }: { entries: Entry[]; timeZone: string }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="relative space-y-5 border-l border-border pl-6">
      {entries.map((e) => {
        const d = describe(e);
        const Icon = d.icon;
        return (
          <li key={e.id} className="relative">
            <span className="absolute top-0.5 -left-[2.05rem] flex size-6 items-center justify-center rounded-full border border-border bg-background">
              <Icon className="size-3.5 text-muted-foreground" aria-hidden />
            </span>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <p className="text-sm font-medium">{d.title}</p>
              <time className="text-xs text-muted-foreground" dateTime={e.occurredAt}>
                {formatDateTime(e.occurredAt, timeZone)}
              </time>
            </div>
            <p className="text-xs text-muted-foreground">
              {e.actorType === "SYSTEM" ? "Automatic" : e.actorType === "CUSTOMER" ? "Customer" : (e.actorName ?? "Team member")}
            </p>
            {d.body && <p className="mt-1 whitespace-pre-wrap text-sm">{d.body}</p>}
          </li>
        );
      })}
    </ol>
  );
}
