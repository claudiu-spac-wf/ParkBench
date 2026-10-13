ARG NODE_BASE_IMAGE=node:24-bookworm-slim
FROM ${NODE_BASE_IMAGE}
# iproute2 provides tc/ip for the run-scoped Database Latency sidecars (feature 016), which reuse
# this image with NET_ADMIN; ordinary observer containers never use it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 \
  && rm -rf /var/lib/apt/lists/*
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
COPY openedge/observers/db/parkbench-db-observer.p /app/openedge/observers/db/parkbench-db-observer.p
COPY openedge/observers/db/parkbench-db-observer-v2.p /app/openedge/observers/db/parkbench-db-observer-v2.p
COPY openedge/observers/db/prepare-run-db-observer.p /app/openedge/observers/db/prepare-run-db-observer.p
ENV PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE=/app/openedge/observers/db/prepare-run-db-observer.p
# The licensed OpenEdge launcher/runtime is supplied by the operator at run time.
# Mount it at /opt/openedge and configure the launcher inside that mount.
VOLUME ["/opt/openedge"]
EXPOSE 9100
CMD ["node", "dist/apps/observer/src/index.js"]
