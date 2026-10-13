ARG NODE_BASE_IMAGE=node:24-bookworm-slim
FROM ${NODE_BASE_IMAGE}
WORKDIR /app
COPY package*.json ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/loadgen/package.json apps/loadgen/package.json
COPY apps/observer/package.json apps/observer/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/compose-runner/package.json packages/compose-runner/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/metrics/package.json packages/metrics/package.json
COPY packages/observers/package.json packages/observers/package.json
COPY packages/test-support/package.json packages/test-support/package.json
RUN npm ci --omit=dev
COPY dist ./dist
# The compiled contracts package loads this shared environment parser at runtime.
COPY scripts/lib/load-env.cjs scripts/lib/load-env.cjs
COPY scripts/lib/resolve-paths.cjs scripts/lib/resolve-paths.cjs
CMD ["node", "dist/apps/loadgen/src/cli.js"]
