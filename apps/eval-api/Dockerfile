# One image runs the Eval API (src/server.ts), the Run Worker (src/run-worker-main.ts) and
# migrations (src/migrate.ts). Build from the repository root:
#   docker build -f apps/eval-api/Dockerfile .
FROM node:24-bookworm-slim AS production

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install --global pnpm@11.6.0 && npm cache clean --force

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/eval-api/package.json apps/eval-api/
COPY packages/eval-contracts/package.json packages/eval-contracts/
COPY packages/eval-dataset/package.json packages/eval-dataset/
COPY packages/eval-metrics/package.json packages/eval-metrics/
COPY packages/eval-runtime/package.json packages/eval-runtime/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@eval-platform/eval-api..." install --frozen-lockfile --prod --store-dir /pnpm/store

COPY packages packages
COPY apps/eval-api apps/eval-api

# The shared Bundle directory; compose mounts a persistent volume here.
RUN install -d -o node -g node /data/bundles
USER node
WORKDIR /app/apps/eval-api
EXPOSE 8788
CMD ["node_modules/.bin/tsx", "src/server.ts"]
