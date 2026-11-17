# Lead & Follow-up Manager — Implementation Plan

Status: approved baseline for Task 2 onward. Architectural decisions are recorded in
[DECISIONS.md](./DECISIONS.md); this file describes *what* gets built and *in what order*.

## 1. Goal of version 1

> No incoming lead gets lost, no assigned employee forgets a follow-up, and no customer
> receives unnecessary repeated messages.

**First vertical slice (must work end-to-end before anything else):**
owner registers → creates organization → adds employees → manually adds a lead → lead is
auto-assigned round-robin → acknowledgement + follow-up task scheduled → activity timeline
shows every step.

**Second slice:** website form capture (signed webhook) + outbound email (SMTP adapter),
inbound reply detection pausing the sequence.

Everything else (WhatsApp, Meta, CRM, Gmail OAuth) is built behind the same adapter
interfaces and is shown as **"Not connected"** until a real credential is authenticated and
tested. Nothing is ever simulated as connected.

## 2. Environment

| Tool | Version found | Use |
|---|---|---|
| Node.js | 22.20 | runtime for web + worker |
| pnpm | 10.34 | workspace package manager |
| Docker | 29.8 | Postgres 16 + Redis 7 for dev; full deployment |
| PostgreSQL / Redis | run through `docker compose` | Postgres published on host port **15432** (5432 and 5433 are used by native Postgres installs on the dev machine; 55432 falls in a Windows-reserved range) |

## 3. Repository layout (pnpm monorepo)

```
automation/
├─ apps/
│  ├─ web/            Next.js 15 (App Router) — UI + REST API route handlers (/api/*)
│  └─ worker/         BullMQ worker process — follow-ups, sending, retries, recovery sweep
├─ packages/
│  ├─ db/             Prisma schema, migrations, client, seed
│  ├─ core/           Domain engine (framework-free, reused by future automation packs)
│  │  ├─ auth/        password hashing, sessions, RBAC policy
│  │  ├─ tenancy/     org-scoped context + guards
│  │  ├─ leads/       normalization, validation, duplicate detection, status machine
│  │  ├─ assignment/  atomic round-robin, availability, fallback
│  │  ├─ followups/   rule engine, scheduling, working hours, stop/pause conditions
│  │  ├─ messaging/   templates, rendering, outbox, consent, channel policy
│  │  ├─ integrations/ adapter registry + provider adapters
│  │  ├─ events/      inbound event idempotency, automation execution log
│  │  └─ crypto/      AES-256-GCM credential encryption, HMAC verification
│  ├─ queue/          BullMQ queue names, job payload schemas, producers
│  └─ shared/         zod schemas & DTO types shared by web, worker and tests
├─ docker/            Dockerfiles
├─ docker-compose.yml
└─ docs/
```

Rationale: the web app and worker must share the exact same domain logic, and the spec asks
for an engine that other automation packs can reuse — so domain code lives in
`packages/core`, never inside Next.js route files.

## 4. Data model (Prisma / PostgreSQL)

All business tables carry `organizationId` and are indexed on it. IDs are `cuid2` strings.

| Table | Key columns / notes |
|---|---|
| `organizations` | name, email, businessType, website, timezone, workingHours (JSON per weekday), holidays, communication prefs |
| `users` | email (unique), name, passwordHash, emailVerifiedAt |
| `sessions` | tokenHash, userId, activeOrganizationId, expiresAt |
| `organization_members` | orgId, userId, role (`OWNER/ADMIN/MANAGER/SALESPERSON`), status (`INVITED/ACTIVE/DISABLED`), isAvailable, unavailableUntil, isFallbackManager |
| `invitations` | orgId, email, role, tokenHash, expiresAt, acceptedAt |
| `integrations` | orgId, provider, kind (source/channel/both), status (`NOT_CONNECTED/PENDING/CONNECTED/ERROR/DISCONNECTED`), encryptedCredentials, config JSON, webhookSecretHash, lastTestedAt, lastError |
| `lead_sources` | orgId, type (`WEBSITE/EMAIL/WHATSAPP/META/CRM/MANUAL`), integrationId?, label |
| `leads` | orgId, name, email, emailNormalized, phone, phoneE164, company, subject, inquiry, sourceId, sourceMetadata JSON, status, priority, assignedMemberId?, duplicateOfId?, lastContactAt, lastCustomerReplyAt, nextFollowUpAt, convertedAt, lostAt, lostReason, optedOutAt |
| `assignments` | orgId, leadId, memberId?, previousMemberId?, method (`ROUND_ROBIN/MANUAL/FALLBACK/UNASSIGNED`), actorUserId?, reason |
| `assignment_cursors` | orgId (PK), lastMemberId — row-locked for atomic round-robin |
| `lead_activities` | orgId, leadId, type (enum ~20 values), actorType (`USER/SYSTEM/CUSTOMER`), actorUserId?, payload JSON, occurredAt |
| `conversations` | orgId, leadId, channel, externalThreadId, windowExpiresAt (WhatsApp 24h) |
| `messages` | orgId, conversationId, leadId, direction, channel, templateId?, body, status (`QUEUED/SENDING/SENT/DELIVERED/READ/FAILED/CANCELLED`), idempotencyKey (unique), providerMessageId, attempts, lastError, sentAt |
| `message_templates` | orgId, key (`ACKNOWLEDGEMENT/FOLLOW_UP_n/CUSTOM`), channel, subject, body, variables, approvalStatus (`DRAFT/APPROVED`), providerTemplateName (WhatsApp), approvedById |
| `follow_up_rules` | orgId, stepIndex, delayMinutes, channels[], templateKey, active |
| `follow_up_tasks` | orgId, leadId, ruleId?, stepIndex, kind (`AUTO_MESSAGE/EMPLOYEE_REMINDER`), status (`SCHEDULED/DUE/IN_PROGRESS/COMPLETED/SKIPPED/CANCELLED/FAILED/PAUSED`), dueAt, completedAt, completedById, note, jobId |
| `automation_configs` | orgId, automationKey (`lead-followup`), status (`DRAFT/ACTIVE/PAUSED`), settings JSON (assignment mode, duplicate policy, sending hours, fallback channel, auto-send), activatedAt, activatedById |
| `automation_executions` | orgId, automationKey, eventType, status (`SUCCESS/FAILED/RETRYING/SKIPPED`), leadId?, messageId?, input/output JSON, error, attempt, retryable, createdAt |
| `inbound_events` | orgId, integrationId, provider, externalEventId, payloadHash, receivedAt — **unique(integrationId, externalEventId)** for idempotency |
| `consents` | orgId, leadId, channel, status (`OPTED_IN/OPTED_OUT`), source, recordedAt |
| `notifications` | orgId, memberId, type, leadId?, readAt |
| `audit_logs` | orgId, actorUserId, action, targetType, targetId, ip, metadata |

**Three independent state machines** (kept separate as the spec requires):
- Lead status: `NEW → ASSIGNED → CONTACTED → WAITING_FOR_CUSTOMER ⇄ FOLLOW_UP_DUE → QUALIFIED → CONVERTED`; `LOST` and `ON_HOLD` reachable from any open state.
- Follow-up task status (above).
- Message delivery status (above).

## 5. Core flows

### 5.1 Lead intake (all sources)
1. Source adapter receives raw payload → `inbound_events` insert (unique constraint ⇒ duplicate webhook is a no-op, return 200).
2. `normalizeLead()` → common `NormalizedLead` (zod-validated; email lower-cased, phone → E.164 via `libphonenumber-js` using org country default).
3. Duplicate detection (org-scoped, by `emailNormalized` OR `phoneE164`, open leads only): policy `MERGE` (append inquiry as activity to existing lead) or `REVIEW` (create lead flagged `duplicateOfId`).
4. Single DB transaction: create lead + `LEAD_CREATED` activity + round-robin assignment + `assignments` row + execution log.
5. After commit: enqueue `send-acknowledgement` (idempotency key `ack:{leadId}:{channel}`) and create first follow-up task.

### 5.2 Atomic round-robin
Inside the intake transaction: `SELECT … FROM assignment_cursors WHERE org_id = $1 FOR UPDATE`
→ load eligible members (`ACTIVE`, role SALESPERSON/MANAGER opted-in, `isAvailable`, not
`unavailableUntil > now`) ordered by `createdAt, id` → pick first member after
`lastMemberId` (wrap around) → update cursor. Concurrent intakes serialize on the row lock, so
two leads can never get the same position. No eligible member → fallback manager → else
unassigned queue (status stays `NEW`, owners/managers notified).

### 5.3 Follow-up engine
- DB is the source of truth; BullMQ delayed jobs are the trigger (`jobId = followUpTaskId` ⇒ enqueueing twice is a no-op).
- **Recovery sweep** (repeatable job, every minute): finds `SCHEDULED` tasks with `dueAt <= now` and no live job → enqueues them. Survives Redis flushes and restarts.
- `dueAt` is pushed into the org's next working window (timezone, working hours, holidays) using Luxon.
- When a task fires, the processor re-reads the lead and checks **stop conditions** before doing anything: lead `CONVERTED/LOST/ON_HOLD`, opted out, customer replied since task was created, automation paused, templates not approved → mark task `SKIPPED`/`PAUSED` with reason.
- Customer reply (inbound message) → record `lastCustomerReplyAt`, pause pending `AUTO_MESSAGE` tasks, set lead `FOLLOW_UP_DUE` (ball is now in the employee's court), create an `EMPLOYEE_REMINDER` task "customer replied", notify assignee.
- Employee logs interaction → record activity, set `lastContactAt`, cancel pending tasks and **recalculate** sequence from step 1 relative to now.

### 5.4 Messaging (outbox)
1. Create `messages` row with unique `idempotencyKey` (`ack:{leadId}:{channel}`, `fu:{taskId}:{channel}`, `manual:{uuid}`) status `QUEUED` — duplicate key ⇒ reuse existing row, never re-send.
2. Worker claims via conditional update `QUEUED → SENDING` (affects 1 row or skip).
3. Policy checks: automation active, template approved, consent, sending hours (else reschedule), WhatsApp 24h window (outside window ⇒ only approved provider template allowed).
4. Adapter `send()` → `SENT` + providerMessageId; delivery webhooks update `DELIVERED/READ/FAILED`.
5. Errors are classified `retryable` (network, 429, 5xx) → BullMQ exponential backoff (5 attempts) vs `permanent` (invalid address, template rejected) → `FAILED`, no retry. Exhausted jobs land in a dead-letter queue and in the Failed Messages view. A retry after an ambiguous timeout re-checks the provider message id first where the provider supports it.
6. Fallback channel (e.g. WhatsApp fails permanently → email) is a *new* message with its own idempotency key.

## 6. Integrations (adapter interface)

```ts
interface ProviderAdapter {
  key: ProviderKey; capabilities: ('lead_source' | 'send' | 'receive' | 'delivery_status')[];
  connect(ctx, input): Promise<ConnectResult>;          // OAuth URL or credential form
  handleCallback?(ctx, params): Promise<void>;
  test(ctx): Promise<TestResult>;                       // real API call; only success ⇒ CONNECTED
  disconnect(ctx): Promise<void>;
  verifyWebhook?(req): Promise<boolean>;                // signature check
  parseInbound?(payload): InboundEvent[];               // leads / messages / statuses
  send?(ctx, msg): Promise<SendResult>;
}
```

| Provider | v1 scope |
|---|---|
| Website webhook + embeddable form | **Full** — per-integration URL token + HMAC-SHA256 signature, CORS-safe hosted form snippet |
| Manual entry | **Full** |
| SMTP email (send) | **Full** — nodemailer; test = SMTP verify |
| IMAP / Gmail (receive + reply detection) | **Full for Gmail OAuth** (send + history polling) when `GOOGLE_CLIENT_ID` is set; otherwise clearly marked "requires configuration" |
| WhatsApp Business Cloud API | Adapter implemented against official Graph API (send template/text, webhook verify `X-Hub-Signature-256`, statuses, inbound). Connect requires real token + phone number ID; test calls the API |
| Meta Lead Ads (FB/IG) | Adapter: OAuth, page/form selection, `leadgen` webhook → Graph fetch. Requires app review — UI states that plainly |
| CRM | Adapter interface + HubSpot implementation (private app token, contacts import); others pluggable |

## 7. API surface

REST under `apps/web/app/api`, every handler wrapped by `withAuth({ permission })` which
resolves session → active org membership → RBAC check → passes an `OrgContext` into core.
Webhook routes use `withWebhook(provider)` instead (signature + idempotency, no session).

Endpoints follow the spec list (`/api/auth`, `/api/organizations`, `/api/members`,
`/api/integrations[/connect|/callback]`, `/api/leads[/:id[/assign|/status|/activities]]`,
`/api/follow-ups[/:id[/complete|/reschedule]]`, `/api/messages[/templates|/send]`,
`/api/automation/{config,activate,pause,executions}`, `/api/webhooks/{website,email,whatsapp,meta}`)
plus `/api/dashboard/overview`, `/api/notifications`, `/api/export`.

## 8. RBAC matrix

| Permission | Owner | Admin | Manager | Salesperson |
|---|:-:|:-:|:-:|:-:|
| Org settings, billing, delete/export data | ✓ | | | |
| Integrations, automation config, templates | ✓ | ✓ | | |
| Manage members / invitations | ✓ | ✓ | ✓ (non-owner roles) | |
| View all leads, reassign, dashboards | ✓ | ✓ | ✓ | |
| View/act on **assigned** leads | ✓ | ✓ | ✓ | ✓ |
| Activate / pause automation | ✓ | ✓ | | |

## 9. UI map (Next.js + Tailwind + shadcn/ui)

- Auth: register (business details + timezone), login, accept invitation.
- Onboarding: marketplace card → **setup wizard** (Sources → Team → Assignment → Follow-ups → Messages → Review & Activate).
- App shell: Overview · Leads · Follow-ups · Activity · Integrations · Settings.
- Leads table: search, filters (status, source, assignee, created, follow-up due, priority), sort, server pagination.
- Lead detail: profile, timeline, conversation history, actions (message, note, status, reassign, schedule, convert, lost).
- Follow-up Center tabs: Due today · Overdue · Upcoming · Waiting for customer · Awaiting employee · Failed messages.
- Automation Activity: execution log with error details + safe retry (only for `retryable` failures).
- Plain-language copy throughout (no "jobs", "nodes", "webhooks" in owner-facing text except the website integration snippet).

## 10. Task breakdown (maps to `tasks.md`)

| # | Task | Deliverables | Done when |
|---|---|---|---|
| 1 | Plan | this file + DECISIONS.md | ✓ |
| 2 | Architecture, DB, auth | monorepo, docker-compose (pg+redis), Prisma schema + first migration, core crypto, session auth, RBAC guard, register/login UI | user can register/login; migration applies; unit tests pass |
| 3 | Orgs & employees | org creation on register, settings page, invite/accept flow, roles, availability toggles, audit log | owner invites employee, employee logs in scoped to org |
| 4 | Leads & dashboard | manual lead CRUD, normalization, duplicates, status machine, leads table, detail page, timeline, overview stats | slice up to "lead visible with timeline" |
| 5 | Round-robin | atomic assignment, availability, fallback, unassigned queue, manual reassign, history | concurrency test: 50 parallel leads distribute evenly, no duplicates |
| 6 | Follow-up scheduler | worker app, BullMQ queues, rules config, working hours, stop/pause logic, recovery sweep, Follow-up Center | tasks fire after worker restart; stop rules covered by tests |
| 7 | Messaging & templates | template editor + preview + approval, variables, outbox, SMTP adapter, consent/opt-out, delivery tracking, retries, DLQ, activity log + safe retry | ack email sent exactly once under duplicate events |
| 8 | External providers | website webhook + form, Gmail OAuth, WhatsApp Cloud API, Meta Lead Ads, HubSpot, integrations UI + wizard | each provider: connect → test → status honest |
| 9 | Full workflow tests | Vitest unit + integration (real Postgres/Redis via compose), Playwright e2e of the vertical slice, security tests (tenant isolation, RBAC, signatures) | CI script green |
| 10 | Docker & docs | production Dockerfiles, compose with migrate step, `.env.example`, README, self-hosting + integration setup guides | `docker compose up` → working app |

## 11. Testing strategy

- **Unit** (Vitest): normalization, phone/email rules, duplicate matcher, round-robin selection, working-hours calculator, stop conditions, template rendering, error classification, crypto.
- **Integration** (Vitest + real Postgres/Redis from compose, separate test DB): intake transaction, concurrent assignment, idempotent webhooks, outbox exactly-once, tenant isolation on every repository function.
- **E2E** (Playwright): register → invite → add lead → see assignment + scheduled follow-up → website webhook lead → reply pauses sequence.

## 12. Risks & how they are handled

| Risk | Mitigation |
|---|---|
| Duplicate sends from retries/webhook replays | unique idempotency keys + conditional status claims + `jobId` dedupe |
| Lost reminders on restart | DB source of truth + recovery sweep |
| Cross-tenant data leak | every core function requires `OrgContext`; integration tests assert isolation; Postgres RLS noted as hardening step |
| Provider approval delays (Meta/WhatsApp) | honest status, nothing marked connected until `test()` passes; app fully usable with website + manual + email |
| Timezone bugs | store UTC, compute in org tz with Luxon, DST tests |
| Spam/limits | per-org send rate limiter (BullMQ limiter), sending hours, opt-out link in every email |
