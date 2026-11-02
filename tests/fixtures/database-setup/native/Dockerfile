# Validation-only process fixture layered on a licensed production DB image.
ARG DB_IMAGE=parkbench/openedge-db:dev
FROM ${DB_IMAGE} AS fixture-build
USER root
RUN microdnf install -y gcc glibc-devel && microdnf clean all
COPY tests/fixtures/database-setup/native/detach.c /tmp/detach.c
RUN cc -std=c11 -Wall -Wextra -Werror -O2 /tmp/detach.c -o /tmp/validation-detach
FROM ${DB_IMAGE}
COPY --from=fixture-build /tmp/validation-detach /usr/local/lib/parkbench/validation-detach
