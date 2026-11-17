# User guide

Lead & Follow-up Manager collects enquiries from your website, email, WhatsApp, Facebook and
Instagram ads and your CRM into one list, hands each one to the next available person on your
team, thanks the customer straight away, and reminds your team to follow up until the lead is won
or lost.

## Getting started (business owner)

1. **Create your account** at your installation's address. You become the business **Owner**.
2. **Settings → Business**: your business name, email, timezone, and **Hours** (working days,
   hours and holidays). Follow-ups and automatic messages respect these.
3. **Team**: invite your colleagues by email and choose their role (below). Each person gets a
   link that works once and expires in 7 days.
4. **Automation → Install automation** opens a six-step setup:
   1. *Sources*: where your leads come from (website, email, WhatsApp, Facebook/Instagram, CRM, manual).
   2. *Team*: who receives new leads.
   3. *Assignment*: round-robin (automatic) or manual.
   4. *Follow-ups*: when reminders happen (default 24 hours, 3 days, 7 days, 14 days) and whether
      each also sends the customer a message.
   5. *Messages*: the acknowledgement and follow-up templates, sending hours, and fallback channel.
   6. *Review*: the checklist, then **Activate**.
5. **Integrations**: connect an email account and/or WhatsApp, and your lead sources.
   See [INTEGRATIONS.md](INTEGRATIONS.md).

Nothing is sent to customers until you activate the automation, every message template it uses
is approved, and the channel is connected. The checklist on the Automation page shows what's
missing. **Pause** stops all automatic messages immediately; reminders for your team continue.

## Roles

| | Owner | Admin | Manager | Salesperson |
|---|:-:|:-:|:-:|:-:|
| Work their own leads, follow-ups and messages | ✓ | ✓ | ✓ | ✓ |
| See and reassign everyone's leads, team performance | ✓ | ✓ | ✓ | |
| Invite and manage salespeople | ✓ | ✓ | ✓ | |
| Invite admins and managers | ✓ | ✓ | | |
| Integrations, automation settings, templates, activation | ✓ | ✓ | | |
| Audit log, retrying failed automations | ✓ | ✓ | | |
| Business settings | ✓ | | | |

## When a lead arrives

- It is checked for duplicates. If the same person already has an open lead (same email or
  phone), the new enquiry is added to it instead of creating a second lead.
- It is assigned to the next person in the rotation who is active, receives leads and isn't
  away. If nobody is available, it goes to a manager; if there is no manager, it waits in the
  **unassigned** list and managers are notified.
- The customer gets your acknowledgement (by email and/or WhatsApp) within a minute, inside your
  sending hours.
- The assigned person is notified (in the app and, if they chose, by email).
- Reminders are scheduled: by default after 24 hours, 3 days, 7 days and 14 days.

## Working your leads

**Overview** shows today's numbers: new leads, follow-ups due and overdue, conversions, and (for
managers) how each team member is doing.

**Leads** lists everything you can see, with search, filters by status, source, assignee and
follow-up date, and sorting. Click a lead for its page:

- **I contacted them**: log a call, email or WhatsApp you made. The next reminders are re-timed
  from this contact.
- **They got back to us**: record that the customer replied (replies to your emails by Gmail and
  WhatsApp are recorded automatically). Automatic follow-ups pause, and you get a reminder to
  respond.
- **Add note**: internal notes; customers never see them.
- **Messages**: send an email or WhatsApp message and see everything sent and received.
- **Actions**: change the status, mark as **Converted** or **Lost** (this stops all follow-ups),
  put **On hold** (pauses them), or reassign.
- The **timeline** records everything that happened, by whom, and when.

**Follow-ups** (the Follow-up Center) groups your reminders into *Due today*, *Overdue*,
*Upcoming*, *Waiting for customer*, *Awaiting action* and *Failed messages*. Mark a reminder done,
reschedule it, or skip it. A reminder still open from before today counts as overdue, and the
owner is told once.

## Automatic messages

- Templates use variables such as `{{customer_name}}`, `{{business_name}}`,
  `{{employee_name}}` (the assigned team member) and `{{inquiry_subject}}`, plus your own custom
  variables; the editor shows a preview. Editing an
  approved template sends it back to draft until it is approved again.
- Messages wait for your sending hours. Failed sends are retried automatically (after 1, 5, 15
  and 60 minutes). If a send was interrupted and it's unclear whether it went out, it is not
  resent automatically; **Activity** shows it with a *Retry* button that asks you to confirm.
- If a channel can't be used (no phone number, no WhatsApp opt-in, not connected), the message
  can go by your fallback channel instead.
- Customers can always unsubscribe from emails (link in every email) or reply STOP on WhatsApp.
  Opted-out customers get no further automatic messages on that channel.

**Activity** (Automation Activity) lists every automated action: leads received, assignments,
messages queued, sent, failed and retried, and follow-ups paused or stopped, with the reason.

## Team availability

In **Team**, managers can mark someone as not receiving leads or away until a date, and
deactivate people who leave. A deactivated person's open leads are shared among the rest of the
team. Each person chooses their own notifications (new lead, follow-up due, customer replied, …)
under **Settings → Notifications**.

## On your phone

The app works in any phone browser; there is nothing to install. Tip: use **Add to Home Screen**
(Safari's Share menu, or Chrome's ⋮ menu) to open it like an app.

- The tab bar at the bottom has **Home, Leads, Follow-ups and Alerts**; everything else
  (Automation, Activity, Integrations, Team, Settings, switching business, sign out) is under **More**.
- On a lead, **Call**, **WhatsApp** and **Email** open your phone's dialer, WhatsApp or mail app
  directly. Afterwards, tap **I contacted them** so the next reminders are re-timed.
- In **Leads**, tap **Filters** for status, source, assignee, dates and sorting.
