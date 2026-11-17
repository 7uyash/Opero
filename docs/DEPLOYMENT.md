# Deploying Lead & Follow-up Manager

This guide runs the whole product on one server with Docker Compose: the web app, the background
worker, PostgreSQL, Redis and (optionally) Caddy for automatic HTTPS.

```
            internet
               │ 443/80
         ┌─────▼─────┐
         │   Caddy   │  HTTPS, certificates (optional profile)
         └─────┬─────┘
               │ web:3000
   ┌───────────▼───────────┐        ┌──────────────┐
   │ web  (Next.js, API,   │◄──────►│  PostgreSQL  │  source of truth
   │       webhooks)       │        └──────▲───────┘
   └───────────┬───────────┘               │
               │ jobs                      │
         ┌─────▼─────┐             ┌───────┴──────┐
         │   Redis   │◄───────────►│    worker    │  follow-ups, sending, inbox polling
         └───────────┘             └──────────────┘
```

`migrate` runs once on every start, applies database migrations, and exits; web and worker wait for it.

## 1. What you need

- A Linux server with Docker Engine 24+ and the Compose plugin. 2 vCPU / 2 GB RAM is enough for a
  small team; building the images needs about 3 GB, so build elsewhere (see [Building images](#building-images-elsewhere)) on smaller machines.
- A domain name (e.g. `leads.example.com`) pointing at the server, with ports **80 and 443** open.
- An email account the business can send from (SMTP, or Gmail with a Google OAuth app).

## 2. Configure

```bash
git clone <your fork or this repository> lead-followup-manager
cd lead-followup-manager
cp .env.production.example .env.production
```

Fill in `.env.production`:

| Variable | Required | What it is |
|---|---|---|
| `APP_URL` | yes | Public address, `https://…`. Used in emails, unsubscribe links, invitation links and OAuth redirects. |
| `DOMAIN` | with Caddy | The host name Caddy gets a certificate for (usually `APP_URL` without `https://`). |
| `LFM_DB_PASSWORD` | yes | Database password. Letters and digits only: `openssl rand -hex 24`. |
| `ENCRYPTION_KEY` | yes | Encrypts saved credentials (AES-256-GCM). `openssl rand -base64 32`. **Back it up**: if it is lost, every integration must be reconnected. |
| `SESSION_SECRET` | yes | Signs sessions, OAuth state and unsubscribe links. `openssl rand -base64 32`, different from the key above. Changing it signs everyone out and invalidates old unsubscribe links. |
| `WEB_BIND`, `WEB_PORT` | no | Where the web container listens on the host. Default `127.0.0.1:3000` (only reachable through a proxy on the same machine). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Enables Gmail. See [INTEGRATIONS.md](INTEGRATIONS.md#gmail). |
| `META_APP_ID`, `META_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | no | Enables WhatsApp Cloud API webhooks and Facebook/Instagram lead ads. See [INTEGRATIONS.md](INTEGRATIONS.md#whatsapp-business-cloud-api). |
| `META_GRAPH_VERSION` | no | Graph API version, default `v23.0`. |
| `LOG_LEVEL` | no | `info` (default), `debug`, `warn`. |
| `FOLLOWUP_SWEEP_MS` | no | How often the worker looks for due work, default 15000. |
| `ALLOW_INSECURE_HTTP` | no | `1` allows an `http://` or localhost `APP_URL`. Only for a private test install. |

The app **refuses to start** in production when something is unsafe or inconsistent (http
`APP_URL`, a key that isn't 32 bytes, the same value for both secrets, half of a provider's
credentials). The reason is printed in the container log.

Integrations you leave unconfigured show as "Requires setup by your administrator" in the app;
nothing pretends to be connected.

## 3. Start

With the built-in HTTPS proxy:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production --profile https up -d --build
```

Behind your own reverse proxy (nginx, Traefik, a cloud load balancer), leave out `--profile https`
and forward to `127.0.0.1:3000`. The proxy must pass the original `Host` header (or set
`X-Forwarded-Host`) and terminate TLS.

Check it:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -s https://leads.example.com/api/health      # {"ok":true,"database":"ok","queue":"ok"}
```

Open `APP_URL`, create the first account (it becomes the business owner), then follow the setup
wizard under **Automation**.

> Tip: put `COMPOSE_FILE=docker-compose.prod.yml` and `COMPOSE_PROFILES=https` in your shell
> profile (and keep `--env-file .env.production`) to shorten the commands below.

## 4. Operate

**Logs**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f web worker
```

Logs are JSON, one line per event, rotated at 5 × 10 MB per container. Secrets, tokens and message
contents are not logged.

**Health.** `GET /api/health` returns 200 when the database and Redis answer, 503 otherwise. The
web container's Docker health check uses it. The worker logs a `sweep` line every 15 seconds
when it has something to do; the **Automation Activity** page shows every automated action and
failure.

**Upgrades**

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production --profile https up -d --build
```

`migrate` applies new migrations before the new web and worker start. Take a backup first: a
migration can't be undone automatically, and restoring the backup is the way back.

**Restarts and outages are safe.** Follow-up reminders and messages are stored in PostgreSQL;
Redis only carries jobs. If the worker or Redis is down, nothing is lost: on start the worker finds
everything that became due meanwhile and handles it once. A message whose send was interrupted
mid-way is marked "delivery unknown" instead of being sent twice; someone can confirm a resend
from Automation Activity.

**Scaling.** Run more worker copies with `--scale worker=2`; jobs are claimed atomically, so two
workers never send the same message. The web container is stateless and can be scaled behind a
load balancer. Note that login and form rate limits are per web container.

## 5. Backups

Everything that matters is in PostgreSQL, plus `.env.production` (above all `ENCRYPTION_KEY`).

```bash
# Back up (run from cron, e.g. nightly, and copy the file off the server)
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  pg_dump -U lfm -d lfm --format=custom > backup-$(date +%F).dump

# Restore into an empty database (stop web and worker first)
docker compose -f docker-compose.prod.yml --env-file .env.production stop web worker
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  pg_restore -U lfm -d lfm --clean --if-exists --no-owner < backup-2026-11-17.dump
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Test a restore now and then: `createdb -U lfm restore_check`, restore into it, count rows, drop it.
Redis needs no backup.

## 6. Security checklist

- [ ] `APP_URL` is `https://`; ports 5432 and 6379 are **not** open to the internet (the compose
      file doesn't publish them).
- [ ] `.env.production` is readable only by the deploy user (`chmod 600`) and never committed.
- [ ] `ENCRYPTION_KEY` and database backups are stored separately from each other.
- [ ] The server gets security updates; images are rebuilt regularly (`up -d --build --pull always`).
- [ ] Only people who need it have the Owner or Admin role; ex-employees are deactivated (their
      open leads are redistributed automatically).

What the app does on its own: hashed passwords (bcrypt), sessions stored only as HMACs,
HttpOnly/Secure/SameSite cookies, same-origin checks on every change, role checks on every API
route, every query scoped to the signed-in business, encrypted provider credentials, signed and
timestamped webhooks, rate-limited login and public forms, and an audit log of sensitive changes.
See [SECURITY.md](../SECURITY.md).

## Building images elsewhere

The images are plain Docker images: build them in CI or on a bigger machine and push them to a
registry.

```bash
docker build --target web    -t registry.example.com/lfm/web:1.0.0 .
docker build --target worker -t registry.example.com/lfm/worker:1.0.0 .
```

Then on the server, override the image names (e.g. in a `docker-compose.override.yml`) and run
`up -d` without `--build`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `web` restarts with "Invalid environment configuration" | Read the listed problems in `logs web`; fix `.env.production`. |
| `migrate` exits with an authentication error after changing `LFM_DB_PASSWORD` | Postgres keeps the password it was first created with. Change it inside the database (`ALTER USER lfm PASSWORD '…'`) or restore into a fresh volume. |
| Caddy can't get a certificate | `DOMAIN` must resolve to this server and ports 80/443 must be reachable from the internet. |
| Automatic emails show "Scheduled" instead of being sent | Outside sending hours (Settings → Messages). They go out when the window opens. |
| Automatic messages never go out | Automation must be **Active** (Automation page checklist) and templates approved. |
| "Requires setup by your administrator" on Gmail / Facebook / WhatsApp | The server has no app credentials for that provider; see [INTEGRATIONS.md](INTEGRATIONS.md). |
| A webhook provider reports 401 | Signature check failed: the app secret or the form's signing secret doesn't match. |
