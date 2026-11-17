# Architecture Decision Records

Short ADRs. Each records context, the decision, and consequences. New decisions are appended.

---

## ADR-001 — pnpm monorepo with a framework-free core package
**Context.** Web UI, REST API and background worker must share identical domain logic, and the
platform will host further automation packs.
**Decision.** `apps/web` (Next.js), `apps/worker` (Node), `packages/{db,core,queue,shared}`.
Domain logic lives only in `packages/core`; route handlers and job processors are thin.
**Consequences.** One place to test business rules; new packs depend on `core`. Slightly more
build configuration (TypeScript project references / `tsup`).

## ADR-002 — REST API via Next.js route handlers, worker as separate process
**Context.** Spec asks for Node + TypeScript REST. A separate Express server would duplicate
auth/session handling.
**Decision.** API lives in `apps/web/app/api/**/route.ts` (Node runtime). Long-running work
never runs in a request; it goes to BullMQ and is processed by `apps/worker`.
**Consequences.** Single deployable for UI+API; worker scales independently. The API can be
extracted later because handlers only call `core`.

## ADR-003 — First-party session authentication instead of Auth.js Credentials
**Context.** Auth.js's credentials provider forces JWT sessions and makes server-side
revocation, org switching and invitation flows awkward. Spec allows "Auth.js or equivalent".
**Decision.** Email + password with `bcryptjs` (pure JS, no native build on Windows/Alpine),
opaque random session token in an `httpOnly; Secure; SameSite=Lax` cookie, SHA-256 hash stored
in `sessions`, 30-day rolling expiry, active organization stored on the session. CSRF: SameSite
cookie + `Origin` header check on mutating requests. Login rate-limited per IP+email.
**Consequences.** Full control and instant revocation. Google OAuth login can be added later as
another way to create a session; Gmail OAuth for *sending* is an integration, not login.

## ADR-004 — Tenant isolation through a mandatory OrgContext
**Context.** One business must never see another's data.
**Decision.** Every core service function takes `ctx: OrgContext { orgId, userId, memberId,
role }` and every Prisma query in core filters by `ctx.orgId`. Loading a record by id always
uses `findFirst({ where: { id, organizationId } })`. Integration tests attempt cross-tenant
access for each resource. Postgres row-level security is a documented hardening step (Task 10).
**Consequences.** Simple and explicit; relies on discipline + tests, hence the test requirement.

## ADR-005 — Atomic round-robin with a row-locked cursor
**Context.** Simultaneous leads must not receive the same rotation slot; membership and
availability change over time.
**Decision.** `assignment_cursors(organizationId PK, lastMemberId)`. Assignment runs in the
intake transaction: `SELECT … FOR UPDATE` on the cursor, compute the next eligible member after
`lastMemberId` in stable order (`createdAt, id`), write cursor + `assignments` row.
**Consequences.** Concurrent intakes serialize per organization only (cheap at SMB volumes).
Removing/adding a member never breaks rotation (no modulo over a changing list).

## ADR-006 — Database is the source of truth for schedules; BullMQ is the trigger
**Context.** Reminders must survive browser closes, server restarts and Redis data loss.
**Decision.** `follow_up_tasks` rows hold `dueAt`/`status`. A delayed BullMQ job with
`jobId = taskId` fires the task; a repeatable **recovery sweep** every minute re-enqueues any
overdue `SCHEDULED` task. Processors re-check the DB state and stop conditions before acting.
**Consequences.** At-least-once triggering, made safe by idempotent processing (ADR-007).
**Update (Task 6).** Implemented as sweep-driven only: the repeatable sweep (every 15 s, configurable via
`FOLLOWUP_SWEEP_MS`) enqueues a processing job per due task, with jobId `fu-<taskId>-<dueAt>` so a
rescheduled task gets a fresh job while the old one is still retained. The web app never needs Redis
for scheduling; reminders are accurate to the sweep interval, which is fine for follow-ups. The worker
also sweeps once on start-up to catch up after downtime.

## ADR-007 — Exactly-once *effects* via idempotency keys and an outbox
**Context.** Webhooks are redelivered; jobs retry; a customer must not get duplicate messages.
**Decision.**
- Inbound: `inbound_events` unique `(integrationId, externalEventId)`; when the provider gives
  no id, use SHA-256 of the canonical payload within a time bucket.
- Outbound: `messages.idempotencyKey` unique (`ack:{leadId}:{channel}`, `fu:{taskId}:{channel}`).
  Worker claims with `UPDATE … SET status='SENDING' WHERE id=? AND status='QUEUED'`.
- Follow-up tasks unique `(leadId, sequenceRunId, stepIndex)`.
**Consequences.** The only residual risk is a provider timeout after the provider accepted the
message; such messages go to `FAILED` with "delivery unknown" and are **not** auto-retried —
they appear in Failed Messages for a human decision.

## ADR-008 — Error classification drives retries
**Decision.** Adapters throw `ProviderError { retryable: boolean, code }`. Retryable → BullMQ
exponential backoff (base 30 s, 5 attempts, jitter). Permanent → `FAILED` immediately.
Exhausted → dead-letter queue + `automation_executions` row with `retryable=true` so the UI can
offer a safe manual retry. "Safe retry" re-uses the same idempotency key.

## ADR-009 — Credential encryption
**Decision.** AES-256-GCM, key from `ENCRYPTION_KEY` (32-byte base64), random 12-byte IV, stored
as `v1:<iv>:<tag>:<ciphertext>`. Key version prefix allows rotation. Credentials are decrypted
only inside adapters and never returned by the API. Webhook secrets are stored as hashes; the
raw secret is shown once on creation.

## ADR-010 — Time handling
**Decision.** Store UTC (`timestamptz`). Business rules (working hours, holidays, sending hours)
computed with Luxon in the organization's IANA timezone. Follow-up delays measured in elapsed
time, then shifted forward into the next working window.

## ADR-011 — Validation and shared contracts
**Decision.** zod schemas in `packages/shared` validate every API body, webhook payload and job
payload; the same types are used by UI forms (react-hook-form + zodResolver).

## ADR-012 — Honest integrations, no mocks in production code
**Decision.** Providers are real adapters against official APIs. Status becomes `CONNECTED` only
after `test()` succeeds against the provider. If the required server-side app credentials
(e.g. `GOOGLE_CLIENT_ID`, `META_APP_ID`) are not configured, the UI shows "Requires setup by
your administrator" with a link to the setup guide. Test doubles live only under `**/test/**`.

## ADR-013 — Logging
**Decision.** `pino` structured JSON logs with `orgId`, `leadId`, `jobId`, `requestId` fields;
secrets redacted via pino `redact`. Business-facing history goes to `automation_executions` and
`lead_activities`, not logs.

## ADR-014 — Testing stack
**Decision.** Vitest for unit/integration (real Postgres + Redis from docker compose, isolated
test database reset per suite), Playwright for end-to-end flows.

## ADR-015 — Assignment details: fallback, availability and redistribution
**Context.** ADR-005 fixes the locking; these are the business rules around it.
**Decision.**
- The rotation ring is every ACTIVE member with `receivesLeads`, ordered by join date. Away members
  keep their place but are skipped; an "away until" date in the past counts as back.
- If the previous assignee left the ring, rotation continues from where they sat (no reset to the top).
- Nobody eligible → fallback managers (fewest open leads first, no rotation slot used) → unassigned
  queue with an in-app notification to owners, admins and managers.
- Duplicates merged into an existing lead don't consume a rotation slot.
- Deactivating a member hands their open leads to the rotation (one short transaction per lead);
  closed leads keep their owner for reporting. Configurable, and also available as a manual action.
- Interactive transactions that take the cursor lock use `maxWait 15s / timeout 20s` so bursts queue
  instead of failing; the concurrency test fires 30 simultaneous intakes.
**Consequences.** Fair, predictable distribution; at very high volume per organization the lock
becomes the throughput limit (acceptable for the SMB target).

## ADR-016 — Follow-up sequence semantics
**Decision.**
- All steps of a sequence are created up front as one run (`seq_…`), so "upcoming" is visible and
  recalculation is a single cancel-and-recreate. Step k is due `delay[k] − delay[from−1]` after the
  anchor, then moved into working hours.
- `leads.followUpStep` records the highest step that became due. An employee contact re-times the
  *remaining* steps from the contact (the sequence doesn't restart on every call). A customer reply, a
  repeat inquiry or reopening a closed lead resets it, so the next contact starts a fresh sequence.
- A newer due reminder supersedes an unanswered older one (no pile-up). One overdue notice is sent per
  reminder after 24 h.
- Converted/lost cancels everything; on hold pauses (manual follow-ups are restored on resume).
- "Overdue" everywhere means open since before *today* in the business timezone.
- Reminders are for employees (`EMPLOYEE_REMINDER`). **Update (Task 7):** instead of separate
  `AUTO_MESSAGE` tasks, the customer message is queued in the outbox when the step fires, keyed
  `fu:<taskId>:<channel>` — one fewer state machine, same stop rules (ADR-017).

## ADR-017 — Messaging engine
**Decision.**
- **Outbox.** Every outbound message is a `messages` row first. Idempotency keys:
  `ack:<leadId>:<channel>`, `fu:<taskId>:<channel>`, `manual:<orgId>:<clientRequestId>` (generated in the
  browser, so a double click or network retry is one message), `<key>:fallback`. Inserts use
  `ON CONFLICT DO NOTHING` so a duplicate never aborts the surrounding transaction.
- **Sending.** The worker claims `QUEUED → SENDING` conditionally and re-checks policy *at send time*:
  opt-out, automation active, auto-send on, lead not closed/on hold, customer hasn't replied since it
  was queued, template still approved, sending hours (deferred, not dropped), WhatsApp 24 h window
  (outside it only a Meta-approved template may be used).
- **Retries are scheduled in the database** (`scheduledFor`: 1, 5, 15, 60 min; 5 attempts), not in
  BullMQ, so they survive restarts and Redis loss; message jobs are single-attempt with id
  `msg-<id>-<attempt>`.
- **Failure kinds.** `temporary_exhausted` and `delivery_unknown` may be retried from the UI;
  `delivery_unknown` (connection lost after DATA, or a worker died mid-send — detected after 10 min in
  `SENDING`) requires explicit confirmation because the customer may already have it. `permanent`
  isn't offered for retry. Retry re-uses the same row and key, so it can't create a second message.
- **Fallback.** An automatic message that fails permanently, or a channel that can't be used for this
  customer, is tried once on the configured fallback channel.
- **Approval.** Only `APPROVED` templates are used automatically; any edit returns a template to
  draft. Activation is refused until every template needed by the enabled message types is approved.
- **Consent.** Opt-out per channel; every email carries a signed one-click unsubscribe link and
  `List-Unsubscribe` headers (RFC 8058). WhatsApp messages are only sent automatically to customers
  who opted in or are inside the 24 h window.
- **Development SMTP.** Mailpit (docker-compose) is a real SMTP server, so the SMTP adapter is
  exercised end to end without mocks; production points the same adapter at the business's provider.
**Consequences.** Exactly-once *effects* except where the provider itself can't tell us (surfaced to
a human, never retried silently). Team notification emails reuse the business's SMTP account and are
skipped when none is connected.

## ADR-018 — External providers and lead ingestion
**Decision.**
- **One ingestion path.** Every automated source calls `ingestLead`, which in a single transaction
  claims the provider event in `inbound_events` (unique per integration + event id, `ON CONFLICT DO
  NOTHING`), normalizes leniently (automated leads are never dropped for an odd phone format),
  applies the duplicate policy, assigns round-robin, records consent, starts follow-ups and queues
  the acknowledgement. A webhook replayed or retried after a crash yields the same lead and no
  second message; the event row stores the lead id so the retry gets the same answer.
- **Website forms.** Server-to-server submissions are HMAC-signed (`X-LFM-Timestamp`,
  `X-LFM-Signature`, 5-minute replay window, optional `Idempotency-Key`). Browser forms can't hold a
  secret, so they're protected by an origin allow-list, a honeypot, a minimum fill time and
  per-IP/per-form rate limits, and their leads are marked `verified: false`. The hosted form
  (`/f/<key>`) is the only page allowed in third-party iframes (`frame-ancestors *`); everything
  else sends `frame-ancestors 'self'` + `X-Frame-Options`. A form becomes CONNECTED on its first
  successful submission.
- **WhatsApp Cloud API / Meta Lead Ads.** Official Graph API only. One app-level webhook per
  deployment, verified with `X-Hub-Signature-256` (`META_APP_SECRET`); events are routed to a
  business by phone-number id / Page id, and one number or Page can belong to only one business.
  New WhatsApp numbers become leads; the inbound message is stored *before* the acknowledgement is
  decided so the 24 h window is open. STOP/START keywords update consent. Lead-ads webhooks fetch
  answers with the Page token; a failed fetch returns 5xx so Meta retries.
- **Gmail** uses OAuth with offline access; tokens refresh automatically and a revoked grant marks
  the connection as needing attention. The inbox is polled (history API, once a minute) rather than
  using Pub/Sub push, so self-hosters need no public push endpoint; `/api/webhooks/email` returns
  410 explaining this. Replies are matched by our `Message-ID` in `In-Reply-To`, then by sender.
  Creating leads from brand-new emails is opt-in.
- **HubSpot** imports only contacts *created after connecting* (no flood of old contacts and no
  acknowledgements to them), one lead per contact id, polled on a configurable interval.
- **OAuth state** is HMAC-signed, expires in 15 minutes, and is bound to the user, business and
  provider that started the flow.
- **Honest status.** Selecting a source in the wizard never marks it connected. Providers that need
  server-side app credentials show "Requires setup by your administrator" naming the missing settings.
- **Adapters resolve lazily** (`channelAdapterFor(integration)`) to avoid import cycles at load time.
- **Testing.** Provider base URLs are configurable (`META_GRAPH_URL`, `GMAIL_API_URL`,
  `GOOGLE_TOKEN_URL`, `HUBSPOT_API_URL`), so tests run the real adapters against a local fake HTTP
  server that lives only under `test/`.
**Consequences.** Without a Meta app that has passed App Review, a Google OAuth client and
(for public Gmail apps) Google verification, those providers stay "requires setup" — by design.


## ADR-019 — Testing the complete workflow

**Context.** Each task added focused tests; Task 9 asks for proof that the pieces work together
and that the security rules hold on every route, not just the ones someone remembered to test.

**Decision.**
- **Layered tests, real infrastructure.** Postgres, Redis, BullMQ and SMTP (Mailpit) are real in
  every integration test. Only third-party HTTP APIs are replaced, by a local fake server under
  `test/`, through the same configurable base URLs production uses.
- **One journey test per layer.** `journey.integration.test.ts` runs the spec's story on a
  simulated clock (calling the same functions the worker calls). `e2e/journey.e2e.test.ts` runs it
  over HTTP through the live web app and worker, so it also covers routing, cookies, queueing and
  SMTP delivery.
- **Exhaustive isolation and guard checks that can't go stale.** The route-guard test reads every
  `route.ts` and fails if one isn't `orgRoute` or on a reviewed public list. The HTTP security
  test fails if any route with an `[id]` is missing from its cross-business table, then calls each
  one with another business's id and checks for 404 *and* that the other business's data didn't change.
- **Browser test kept small.** One Playwright journey, one worker, checks screens render and main
  buttons work; behaviour is asserted at the API layer where it is cheaper and less flaky.

**Found and fixed while doing this.**
- `List-Unsubscribe` pointed at the confirmation *page*, so mail clients' one-click unsubscribe
  (an RFC 8058 POST) did nothing. It now points at `/api/unsubscribe/<token>`; a GET there only
  redirects to the page, so link scanners can't unsubscribe anyone.
- HubSpot "sync now" answered 422 instead of 404 for an id outside the caller's business
  (not a leak — the query was already scoped — but inconsistent with every other route).

## ADR-020 — Production packaging and deployment

**Context.** The product must be self-hostable by a small business or an agency without a
platform team, with safe defaults.

**Decision.**
- **One Dockerfile, two images.** `web` uses Next.js standalone output (no full `node_modules`,
  ~370 MB). `worker` holds only the worker's production dependencies and runs the TypeScript
  sources with `tsx`, as in development (~560 MB); the same image runs `prisma migrate deploy`
  (Prisma CLI is therefore a runtime dependency of `@lfm/db`). Both run as the unprivileged
  `node` user under `tini`.
- **Compose with a one-shot `migrate` service** that web and worker wait for
  (`service_completed_successfully`). Postgres and Redis are not published; web binds to
  127.0.0.1 so it is reachable only through a proxy. Optional Caddy profile for automatic HTTPS
  and HSTS.
- **Fail closed on configuration.** In production the web server (via `instrumentation.ts`) and
  the worker refuse to start on unsafe settings: non-https or localhost `APP_URL`, malformed or
  reused secrets, half-configured providers. `ALLOW_INSECURE_HTTP=1` exists for private test installs.
- **`/api/health`** reports only whether the database and Redis answer; used by Docker's health check.
- **`LFM_DB_PASSWORD`, not `POSTGRES_PASSWORD`.** Compose lets shell variables override
  `--env-file`; a machine-wide `POSTGRES_PASSWORD` (common after installing PostgreSQL locally)
  silently replaced the configured password during testing.

**Verified.** Both images built; the stack started from scratch (migrations applied, web healthy,
worker sweeping); the HTTP security suite (58), the HTTP journey with real email delivery from
the containerised worker (8) and the browser journey (1) all passed against it; bad
configuration made both containers exit with a clear message; a `pg_dump` backup restored into a
scratch database.

**Consequences.** The worker image is larger than a bundled build would be; bundling is a later
optimisation. Rate limits stay per web container (see SECURITY.md).
