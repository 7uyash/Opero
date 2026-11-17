# syntax=docker/dockerfile:1.7
#
# One Dockerfile, two images:
#   --target web     Next.js app (standalone server), port 3000
#   --target worker  background worker; the same image runs database migrations
#
# docker compose -f docker-compose.prod.yml builds both; see docs/DEPLOYMENT.md.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- shared base: OpenSSL for Prisma, pnpm via corepack ----------
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.34.2 --activate
WORKDIR /app

# ---------- workspace manifests only (keeps the dependency layer cached) ----------
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/shared/package.json packages/shared/
COPY packages/db/prisma packages/db/prisma

# ---------- full install + build of the web app ----------
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @lfm/db exec prisma generate
RUN cd apps/web && pnpm exec next build

# ---------- production dependencies for the worker (and the Prisma CLI for migrations) ----------
FROM manifests AS worker-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@lfm/worker..."
RUN pnpm --filter @lfm/db exec prisma generate

# ---------- minimal runtime base: no pnpm, no build tools ----------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

# ---------- web ----------
FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ---------- worker (also runs `prisma migrate deploy`, see docker-compose.prod.yml) ----------
FROM runtime AS worker
COPY --from=worker-deps --chown=node:node /app ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/worker ./apps/worker
USER node
WORKDIR /app/apps/worker
CMD ["node", "--import", "tsx", "src/index.ts"]
