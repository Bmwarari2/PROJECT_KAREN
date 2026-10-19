# syntax=docker/dockerfile:1.7
# Build context: repository root.
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @thapsus/worker... --filter thapsus-hr
RUN node scripts/bundle.mjs apps/worker/src/main.ts apps/worker/dist/main.mjs
RUN pnpm deploy --filter @thapsus/worker --prod --legacy /out && cp -r apps/worker/dist /out/dist

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
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
