# syntax=docker/dockerfile:1.7
# Build context: repository root. Same image runs the cell API, the global API (SERVICE_ROLE=global),
# the migrator (command override: node dist/migrate.mjs) and the dedicated-database move runner
# (command override: node dist/move-tenant.mjs --process-requests; runbook move-tenant-to-dedicated-db.md).
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @thapsus/api... --filter thapsus-hr
RUN node scripts/bundle.mjs apps/api/src/main.ts apps/api/dist/main.mjs \
 && node scripts/bundle.mjs packages/db/src/cli/migrate.ts apps/api/dist/migrate.mjs \
 && node scripts/bundle.mjs apps/api/src/cli/synth-enterprise.ts apps/api/dist/synth.mjs \
 && node scripts/bundle.mjs packages/db/src/cli/move-tenant.ts apps/api/dist/move-tenant.mjs \
 && cp -r packages/db/migrations apps/api/dist/migrations
RUN pnpm deploy --filter @thapsus/api --prod --legacy /out && cp -r apps/api/dist /out/dist

FROM node:24-bookworm-slim
ENV NODE_ENV=production
# Amazon RDS certificate authorities, pinned by checksum, so connections to the Aurora endpoints are
# verified (sslmode=verify-full; RDS Proxy presents a publicly trusted ACM certificate). ASVS V12.3.2.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
RUN groupadd -r app && useradd -r -g app app
WORKDIR /srv
COPY --from=build --chown=app:app /out ./
USER app
EXPOSE 4000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
