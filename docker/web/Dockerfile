ARG NODE_BASE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginx:1.29.1-alpine
FROM ${NODE_BASE_IMAGE} AS build
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
RUN npm ci
COPY apps/web apps/web
COPY packages/contracts/src packages/contracts/src
COPY packages/dashboards/src packages/dashboards/src
RUN npm run build --workspace @parkbench/web

FROM ${NGINX_IMAGE}
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
