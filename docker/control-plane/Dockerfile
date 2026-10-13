ARG NODE_BASE_IMAGE=node:24-bookworm-slim
FROM ${NODE_BASE_IMAGE}
WORKDIR /app
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io=20.10.24+dfsg1-1+deb12u1+b6 \
  && case "${TARGETARCH:-amd64}" in \
    amd64) compose_arch=x86_64 ;; \
    arm64) compose_arch=aarch64 ;; \
    *) echo "unsupported Docker Compose architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && install -d /usr/local/lib/docker/cli-plugins \
  && curl --fail --location --retry 5 --retry-all-errors \
    "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${compose_arch}" \
    --output /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose \
  && docker compose version \
  && rm -rf /var/lib/apt/lists/*
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
COPY examples/scenarios ./examples/scenarios
COPY openedge/workloads/Workloads ./openedge/workloads/Workloads
COPY openedge/runner ./openedge/runner
COPY scripts/openedge ./scripts/openedge
# The compiled contracts package loads this shared environment parser at runtime.
COPY scripts/lib/load-env.cjs scripts/lib/load-env.cjs
COPY scripts/lib/resolve-paths.cjs scripts/lib/resolve-paths.cjs
COPY scripts/lib/docker-target.cjs scripts/lib/docker-target.cjs
COPY scripts/lib/cpuset.cjs scripts/lib/cpuset.cjs
COPY scripts/lib/db-memory.cjs scripts/lib/db-memory.cjs
EXPOSE 3000
CMD ["node", "dist/apps/control-plane/src/index.js"]
