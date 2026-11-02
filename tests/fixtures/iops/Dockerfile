ARG NODE_BASE_IMAGE=node:24-bookworm-slim
FROM ${NODE_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends fio && rm -rf /var/lib/apt/lists/*
CMD ["sh", "-c", "mkdir -p /psc/wrk/fixture; exec sleep infinity"]
