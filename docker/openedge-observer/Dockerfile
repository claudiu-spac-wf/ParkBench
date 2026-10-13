ARG OBSERVER_BASE_IMAGE=progresssoftware/prgs-oedb:12.8.11_ent
ARG NODE_BASE_IMAGE=node:24-bookworm-slim
FROM ${OBSERVER_BASE_IMAGE} AS openedge-runtime
FROM ${NODE_BASE_IMAGE}
ARG OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION=3
ARG OPENEDGE_DB_OBSERVER_SOURCE_SHA256

LABEL org.parkbench.openedge-db-observer.protocol-version=${OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION} \
      org.parkbench.openedge-db-observer.procedure="parkbench-db-observer-v2.r" \
      org.parkbench.openedge-db-observer.source-sha256=${OPENEDGE_DB_OBSERVER_SOURCE_SHA256}

WORKDIR /app

COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
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

COPY --from=openedge-runtime /psc/dlc /psc/dlc
COPY --from=openedge-runtime /etc/protocols /etc/protocols
COPY --from=openedge-runtime /etc/services /etc/services

USER root
COPY license/progress.cfg /psc/dlc/progress.cfg
COPY dist ./dist
# The compiled contracts package loads this shared environment parser at runtime.
COPY scripts/lib/load-env.cjs scripts/lib/load-env.cjs
COPY scripts/lib/resolve-paths.cjs scripts/lib/resolve-paths.cjs
COPY parkbench-db-observer-v2.p /app/openedge/observers/db/parkbench-db-observer-v2.p
COPY parkbench-db-observer-v2.r /app/openedge/observers/db/parkbench-db-observer-v2.r
COPY parkbench-openedge-db-observer /usr/local/bin/parkbench-openedge-db-observer
RUN chmod 0755 /usr/local/bin/parkbench-openedge-db-observer
ENV DLC=/psc/dlc \
    WRKDIR=/psc/wrk \
    PATH=/psc/dlc:/psc/dlc/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DB_HOST=database \
    DB_BROKER_PORT=20931 \
    PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE=/app/openedge/observers/db/parkbench-db-observer-v2.r \
    PARKBENCH_OBSERVER_READ_ONLY=true
EXPOSE 9100
CMD ["node", "dist/apps/observer/src/index.js"]
