# Contributing

Thanks for helping! Set up a development environment with the steps in the [README](README.md).

## Before you open a pull request

```bash
pnpm verify          # typecheck + unit and integration tests
pnpm test:e2e        # with `pnpm dev` and `pnpm dev:worker` running
```

- New API routes go through `orgRoute(permission, …)` (or, if they truly can't have a session,
  are added to the reviewed list in `apps/web/test/route-guards.test.ts` with what authorizes
  them). Routes that take a record id must be added to the cross-business table in
  `e2e/security.e2e.test.ts`; both tests fail until you do.
- Every database query is scoped by `organizationId` from the `OrgContext`, never from request input.
- Integrations implement the `ChannelAdapter` interface and classify errors as `temporary`,
  `permanent` or `delivery_unknown`. Never report a connection as working without a real check
  against the provider. Tests use the local fake provider server, never real accounts.
- Schema changes: `pnpm db:migrate` (creates a migration), then `pnpm --filter @lfm/db migrate:test`.
- Record significant design choices as an ADR in [docs/DECISIONS.md](docs/DECISIONS.md).

Security issues: see [SECURITY.md](SECURITY.md); please don't open public issues for them.
