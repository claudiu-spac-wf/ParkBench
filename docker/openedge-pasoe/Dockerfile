ARG PASOE_BASE_IMAGE=progresssoftware/prgs-pasoe:12.8.11
ARG DB_BASE_IMAGE=progresssoftware/prgs-oedb:12.8.11_ent
ARG JDK_IMAGE=eclipse-temurin:17.0.20_8-jdk
FROM ${DB_BASE_IMAGE} AS db-source
FROM ${PASOE_BASE_IMAGE} AS pasoe-base
FROM ${JDK_IMAGE} AS jdk-source
FROM pasoe-base

USER root
COPY license/progress.cfg /psc/dlc/progress.cfg
COPY runner/oepas1.zip /deploy/artifacts/oepas1.zip
COPY runtime.properties /deploy/scripts/config/runtime.properties
COPY entrypoint.sh /usr/local/bin/parkbench-pasoe-entrypoint.sh
COPY apply-db-connection.sh /usr/local/bin/parkbench-pasoe-apply-db-connection.sh
ARG JDK_PATH=/usr/lib/jvm
ARG PARKBENCH_IMAGE_STAGE=generic
ARG PARKBENCH_READY=false
COPY --from=jdk-source ${JDK_PATH}/ /usr/java/
RUN chmod 0755 /usr/local/bin/parkbench-pasoe-entrypoint.sh /usr/local/bin/parkbench-pasoe-apply-db-connection.sh \
    && mkdir -p /deploy/artifacts /deploy/scripts/config /psc/wrk \
    && chown pscadmin:pscadmin /deploy/scripts/config/runtime.properties \
    && chmod 0644 /deploy/scripts/config/runtime.properties

# The supplied PASOE base image ships the HTTP connector behind its
# feature:begin:HTTP:off marker. ParkBench's initial transport contract is
# HTTP on port 8810, so enable that connector in the reusable wrapper image.
RUN sed -i \
    -e 's/<!-- feature:begin:HTTP:off//' \
    -e 's/feature:end:HTTP:off -->//' \
    /psc/dlc/servers/pasoe/conf/server.xml

# Keep the reusable instance's management applications available to every
# generated PASOE instance. The supplied start script invokes pasman without
# its copy-all flag, so add it to the image-owned deployment macro.
RUN awk 'index($0, "<arg value=\"create\" />") { in_create=1; added=0 } in_create && !added && index($0, "<arg value=\"-v\" />") { print; print "\t\t\t\t<arg value=\"-f\" />"; added=1; next } in_create && index($0, "<arg value=\"@{INSTANCE-NAME}\" />") { in_create=0 } { print }' \
    /deploy/scripts/build.xml > /tmp/parkbench-build.xml \
    && mv /tmp/parkbench-build.xml /deploy/scripts/build.xml

# The stock container-security policy grants GET access only to one-segment
# paths. Metrics live below /mgmt, so explicitly authorize that read-only
# endpoint for the same PAS roles before the policy's deny-all rule.
RUN awk '{ print; if (index($0, "<createPasInstance INSTANCE-BASE-DIR=")) print "\t\t<replace file=\"${INSTANCE.ROOT}/webapps/oemanager/WEB-INF/oemgrSecurity-container.xml\" token=\"        &lt;intercept-url pattern=&quot;/*&quot; method=&quot;GET&quot; access=&quot;hasAnyRole(\047ROLE_PSCAdmin\047,\047ROLE_PSCOper\047,\047ROLE_PSCUser\047)&quot;/&gt;\" value=\"        &lt;intercept-url pattern=&quot;/mgmt/**&quot; method=&quot;GET&quot; access=&quot;hasAnyRole(\047ROLE_PSCAdmin\047,\047ROLE_PSCOper\047,\047ROLE_PSCUser\047)&quot;/&gt;\&#10;        &lt;intercept-url pattern=&quot;/*&quot; method=&quot;GET&quot; access=&quot;hasAnyRole(\047ROLE_PSCAdmin\047,\047ROLE_PSCOper\047,\047ROLE_PSCUser\047)&quot;/&gt;\" />" }' \
    /deploy/scripts/build.xml > /tmp/parkbench-build.xml \
    && mv /tmp/parkbench-build.xml /deploy/scripts/build.xml

ENV PAS_INSTANCE_NAME=oepas1 \
    INSTANCE_NAME=oepas1 \
    DLC=/psc/dlc \
    WRKDIR=/psc/wrk \
    JAVA_HOME=/usr/java \
    PASOE_HTTP_PORT=8810 \
    PARKBENCH_PAS_PROTOCOL=http \
    PARKBENCH_IMAGE_STAGE=${PARKBENCH_IMAGE_STAGE} \
    PARKBENCH_READY=${PARKBENCH_READY}
VOLUME ["/psc/wrk"]
EXPOSE 8810 8811
ENTRYPOINT ["/usr/local/bin/parkbench-pasoe-entrypoint.sh"]
USER pscadmin
