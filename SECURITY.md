# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability**
on this repository, not in a public issue. Include steps to reproduce and the affected version.
We aim to acknowledge reports within 3 working days.

## How the application protects data

| Area | Protection |
|---|---|
| Accounts | Passwords hashed with bcrypt; login timing equalised so it doesn't reveal which emails exist; login, invitation and public-form rate limits. |
| Sessions | Random opaque tokens; only an HMAC of the token is stored; HttpOnly, Secure, SameSite=Lax cookies; 30-day rolling expiry; logout deletes the session server-side. |
| Requests | Every state-changing request must come from the app's own origin (CSRF). Every API route goes through a guard that checks the session, active membership and role; a test fails the build if a route is added without one. |
| Business isolation | Every query is scoped to the signed-in business. Records of another business answer "not found" (tested on every route that takes an id). |
| Credentials | Provider tokens and passwords are encrypted with AES-256-GCM (`ENCRYPTION_KEY`), never returned by the API, and deleted on disconnect. |
| Webhooks | Website: HMAC-SHA256 over timestamp and body, 5-minute window. WhatsApp/Meta: `X-Hub-Signature-256` with the app secret. OAuth: signed, expiring `state` tied to the user and business. Unsubscribe links: signed tokens. |
| Customers | Unsubscribe and WhatsApp STOP are honoured on every automatic message; one-click unsubscribe (RFC 8058); GET requests never change consent. |
| Browser | `X-Frame-Options`/`frame-ancestors` (only the public form may be embedded), `nosniff`, strict referrer policy, no `X-Powered-By`; HSTS through the bundled Caddy config. |
| Operations | Audit log of sensitive changes (roles, integrations, automation, templates); logs exclude secrets, tokens and message bodies; production refuses to start with unsafe configuration. |

Deployment hardening is covered in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#6-security-checklist).

## Known limitations

- Rate limits are kept in memory per web container; with several web containers, each has its own.
- Tenant isolation is enforced in the application layer (with tests), not by PostgreSQL row-level security.
