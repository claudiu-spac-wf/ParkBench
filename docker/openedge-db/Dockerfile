ARG DB_BASE_IMAGE=progresssoftware/prgs-oedb:12.8.11_ent
ARG JDK_IMAGE=eclipse-temurin:17.0.20_8-jdk
FROM ${DB_BASE_IMAGE} AS db-base
FROM ${JDK_IMAGE} AS jdk-source
FROM db-base

USER root
COPY license/progress.cfg /psc/dlc/progress.cfg
COPY entrypoint.sh /usr/local/bin/parkbench-db-entrypoint.sh
COPY copy-seed.sh /usr/local/bin/parkbench-db-copy-seed.sh
COPY prepare-controls.sh /usr/local/bin/parkbench-db-prepare-controls.sh
COPY controls-lifecycle.sh /usr/local/bin/parkbench-db-controls-lifecycle.sh
COPY parkbench-db-startup-state.p compile-startup-state.p /usr/local/lib/parkbench/
ARG JDK_PATH=/usr/lib/jvm
COPY --from=jdk-source ${JDK_PATH}/ /usr/java/
RUN microdnf install -y tar gzip \
    && microdnf clean all \
    && chmod 0755 /usr/local/bin/parkbench-db-entrypoint.sh /usr/local/bin/parkbench-db-copy-seed.sh \
    && chmod 0755 /usr/local/bin/parkbench-db-prepare-controls.sh /usr/local/bin/parkbench-db-controls-lifecycle.sh \
    && mkdir -p /deploy/artifacts /psc/wrk \
    && /psc/dlc/bin/procopy /psc/dlc/prolang/utf/empty8 /tmp/pbcompile \
    && chown -R pscadmin /usr/local/lib/parkbench /tmp/pbcompile.* \
    && /psc/dlc/bin/pro -b -T /tmp -db /tmp/pbcompile -p /usr/local/lib/parkbench/compile-startup-state.p \
    && test -s /usr/local/lib/parkbench/parkbench-db-startup-state.r \
    && chown -R root /usr/local/lib/parkbench \
    && rm -f /tmp/pbcompile.*

ENV DB_BROKER_PORT=20931 \
    DB_MINPORT=20932 \
    DB_MAXPORT=20941 \
    DLC=/psc/dlc \
    WRKDIR=/psc/wrk \
    JAVA_HOME=/usr/java \
    PARKBENCH_DB_WORKDIR=/psc/wrk
VOLUME ["/psc/wrk"]
EXPOSE 20931 20932-20941
ENTRYPOINT ["/usr/local/bin/parkbench-db-entrypoint.sh"]
USER pscadmin
