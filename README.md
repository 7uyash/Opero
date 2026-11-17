# Lead & Follow-up Manager

Open-source lead capture, assignment and follow-up automation for small businesses — part of the
Business Automation Platform.

- **Capture** leads from website forms, email (Gmail), WhatsApp Business, Facebook/Instagram lead
  ads, HubSpot and manual entry, with duplicate detection and idempotent ingestion.
- **Assign** each lead by round-robin to available team members, with a fallback manager and an
  unassigned queue.
- **Acknowledge** customers automatically by email or WhatsApp with approved templates, inside
  your sending hours.
- **Follow up** after 24 hours, 3 days, 7 days and 14 days (configurable, in working hours);
  pause when the customer replies, stop when the lead is converted, lost or opted out.
- **See** everything: dashboard, leads, lead timeline, Follow-up Center, Automation Activity.

| Documentation | |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Self-hosting with Docker: configuration, HTTPS, upgrades, backups, troubleshooting |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Connecting website forms, SMTP, Gmail, WhatsApp, Meta lead ads, HubSpot |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | For business owners and staff |
| [SECURITY.md](SECURITY.md) | Reporting vulnerabilities; how data is protected |
| [docs/PLAN.md](docs/PLAN.md), [docs/DECISIONS.md](docs/DECISIONS.md) | Design and architecture decisions |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow |

## Quick start (Docker)

```bash
cp .env.production.example .env.production   # fill in APP_URL, LFM_DB_PASSWORD, ENCRYPTION_KEY, SESSION_SECRET
docker compose -f docker-compose.prod.yml --env-file .env.production --profile https up -d --build
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for details.

## Local development

Requirements: Node 22+, pnpm 10+, Docker.

```bash
pnpm install
cp .env.example .env          # then fill ENCRYPTION_KEY and SESSION_SECRET (generator command inside)
pnpm db:up                    # Postgres 16 on localhost:15432, Redis 7 on localhost:6379
docker compose up -d mailpit  # dev SMTP server; open http://localhost:8025 to read sent mail
pnpm db:migrate               # apply migrations to the dev database
pnpm --filter @lfm/db migrate:test   # apply migrations to the test database
pnpm dev                      # web app on http://localhost:3000
pnpm dev:worker               # background worker (follow-up reminders) — run in a second terminal
```

Postgres is published on host port **15432** (not 5432) so it doesn't clash with a locally
installed PostgreSQL. For local email, connect Integrations → Email (SMTP) to host `localhost`,
port `1025`, STARTTLS, no username — every email lands in Mailpit instead of a real inbox.
The messaging tests also need Mailpit running.

| Command | What it does |
|---|---|
| `pnpm test` | unit + integration tests (uses the `lfm_test` database) |
| `pnpm typecheck` | TypeScript check of every package |
| `pnpm verify` | typecheck + all unit/integration tests — run before every commit |
| `pnpm test:e2e` | HTTP end-to-end tests against the running app and worker |
| `pnpm test:browser` | Playwright browser test of the main screens against the running app |
| `pnpm verify:all` | all of the above |
| `pnpm db:studio` | browse the dev database |

## Tests

| Layer | Where | Needs |
|---|---|---|
| Unit | `packages/*/test/*.test.ts` (normalisation, working hours, templates, round-robin picking, crypto) | nothing |
| Integration | `packages/core/test/*.integration.test.ts` — real Postgres, real SMTP (Mailpit), a local fake HTTP server standing in for Meta/Google/HubSpot | `pnpm db:up`, Mailpit |
| Full journey | `packages/core/test/journey.integration.test.ts` — setup → website lead → round-robin → acknowledgement → 24h follow-up email → customer reply pauses → call re-times → converted stops everything → unsubscribe, on a simulated clock | same |
| Worker | `apps/worker/test` — a real BullMQ worker: restart catch-up, Redis loss, no double firing | Redis |
| Route guards | `apps/web/test/route-guards.test.ts` — every API route must be signed-in (`orgRoute`) or on a reviewed public list; a new unguarded route fails the build | nothing |
| HTTP end-to-end | `e2e/*.e2e.test.ts` — the journey through the real web app, worker and Mailpit; another business's id on **every** `[id]` route returns 404 and changes nothing; role checks; CSRF; cookie flags; headers; webhook signatures | `pnpm dev` + `pnpm dev:worker` |
| Browser | `e2e/browser/*.spec.ts` (Playwright) | the running app; `npx playwright install chromium` once, or `PW_CHANNEL=chrome` to use an installed Chrome |

End-to-end tests write to the app's own database, creating uniquely named businesses each run.
Point them elsewhere with `E2E_BASE_URL` (and `E2E_DATABASE_URL`).

## Layout

```
apps/web         Next.js UI + REST API (/api/*), webhooks, public form
apps/worker      BullMQ worker: follow-ups, message sending, inbox polling, CRM sync
packages/core    domain engine: auth, tenancy/RBAC, leads, assignment, follow-ups, messaging, integrations, audit
packages/queue   queue names, job payloads, Redis connections
packages/db      Prisma schema, migrations, client
packages/shared  zod schemas and types shared by UI, API and worker
e2e/             HTTP and browser end-to-end tests
docker/          Caddyfile (HTTPS proxy), dev database init
Dockerfile       production images (targets: web, worker)
```
