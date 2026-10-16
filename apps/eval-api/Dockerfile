# One image runs the Eval API (dist/server.js), the Run Worker (dist/run-worker-main.js) and
# migrations (dist/migrate.js). Build from the repository root:
#   docker build -f apps/eval-api/Dockerfile .
FROM node:24-bookworm-slim AS build-tools
RUN npm install --global pnpm@11.6.0 && npm cache clean --force
WORKDIR /app

FROM build-tools AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm-workspace.yaml lists patched dependencies; a frozen install verifies every patch file.
COPY patches patches
COPY apps/eval-api/package.json apps/eval-api/
COPY packages/eval-contracts/package.json packages/eval-contracts/
COPY packages/eval-dataset/package.json packages/eval-dataset/
COPY packages/eval-metrics/package.json packages/eval-metrics/
COPY packages/eval-runtime/package.json packages/eval-runtime/
RUN --mount=type=cache,id=eval-platform-pnpm,target=/pnpm/store \
    pnpm --filter "@eval-platform/eval-api..." install --frozen-lockfile --store-dir /pnpm/store
COPY packages packages
COPY apps/eval-api apps/eval-api
RUN pnpm --filter @eval-platform/eval-api build \
    && node apps/eval-api/scripts/runtime-package.mjs

FROM build-tools AS runtime-deps
WORKDIR /app/api
COPY --from=build /app/apps/eval-api/dist/runtime-package/ ./
RUN --mount=type=cache,id=eval-platform-pnpm,target=/pnpm/store \
    pnpm install --prod --ignore-scripts --frozen-lockfile --store-dir /pnpm/store \
    && node -e "import('pg').then(() => console.log('Runtime dependencies load.'))"

FROM node:24-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app/api
COPY --from=runtime-deps /app/api/package.json ./
COPY --from=runtime-deps /app/api/node_modules ./node_modules
COPY --from=build /app/apps/eval-api/dist/*.js ./dist/
COPY --from=build /app/apps/eval-api/migrations-postgres ./migrations-postgres
# The shared Bundle directory; compose mounts a persistent volume here.
RUN install -d -o node -g node /data/bundles
USER node
EXPOSE 8788
CMD ["node", "dist/server.js"]
