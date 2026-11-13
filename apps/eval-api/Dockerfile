# One image runs the API, Run Worker, optional import Worker and migrations.
# Build from the repository root:
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
# SP packages consumed from source through the vendor/sp-platform submodule.
COPY vendor/sp-platform/packages/agent-contracts/package.json vendor/sp-platform/packages/agent-contracts/
COPY vendor/sp-platform/packages/contracts/package.json vendor/sp-platform/packages/contracts/
COPY vendor/sp-platform/packages/eval-harness/package.json vendor/sp-platform/packages/eval-harness/
COPY vendor/sp-platform/packages/file-renderers/package.json vendor/sp-platform/packages/file-renderers/
COPY vendor/sp-platform/packages/resource/package.json vendor/sp-platform/packages/resource/
COPY vendor/sp-platform/packages/utils/package.json vendor/sp-platform/packages/utils/
# file-renderers installs this tarball by relative path.
COPY vendor/sp-platform/vendor/silurus-ooxml-0.88.0-alt.tgz vendor/sp-platform/vendor/
RUN --mount=type=cache,id=eval-platform-pnpm,target=/pnpm/store \
    pnpm --filter "@eval-platform/eval-api..." install --frozen-lockfile --store-dir /pnpm/store
COPY packages packages
COPY vendor/sp-platform/packages vendor/sp-platform/packages
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
