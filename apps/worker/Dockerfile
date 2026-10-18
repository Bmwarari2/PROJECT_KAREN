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
RUN groupadd -r app && useradd -r -g app app
WORKDIR /srv
COPY --from=build --chown=app:app /out ./
USER app
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
