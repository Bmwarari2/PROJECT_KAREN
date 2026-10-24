# syntax=docker/dockerfile:1.7
# Build context: repository root.
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @thapsus/worker... --filter thapsus-hr
RUN node scripts/bundle.mjs apps/worker/src/main.ts apps/worker/dist/main.mjs
# the signature font (Alex Brush, SIL OFL, with its licence) next to the bundle: ../assets/fonts (ADR-0197)
RUN pnpm deploy --filter @thapsus/worker --prod --legacy --config.node-linker=hoisted /out && cp -r apps/worker/dist /out/dist \
 && mkdir -p /out/assets && cp -r assets/fonts /out/assets/fonts

FROM node:24-bookworm-slim
ENV NODE_ENV=production
# Amazon RDS certificate authorities, pinned by checksum, so connections to the Aurora endpoints are
# verified (sslmode=verify-full; RDS Proxy presents a publicly trusted ACM certificate). ASVS V12.3.2.
# The slim base image has no /etc/ssl: create it first, or ADD --chmod gives the new directories mode
# 644, nobody can enter them, and Node stops at start-up reading /etc/ssl/openssl.cnf.
RUN mkdir -p /etc/ssl/certs
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
RUN groupadd -r app && useradd -r -g app app
WORKDIR /srv
COPY --from=build --chown=app:app /out ./
USER app
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
