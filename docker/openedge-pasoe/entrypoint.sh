#!/bin/sh
set -eu

: "${INSTANCE_NAME:=${PAS_INSTANCE_NAME:-oepas1}}"
: "${WRKDIR:=/psc/wrk}"
: "${DLC:=/psc/dlc}"
: "${JAVA_HOME:=/usr/java}"
: "${PARKBENCH_PAS_MAX_THREADS:=}"

if [ ! -s /psc/dlc/progress.cfg ]; then
  echo "pasoe_license_missing" >&2
  exit 42
fi
if [ ! -s /deploy/artifacts/oepas1.zip ]; then
  echo "pasoe_runner_archive_missing" >&2
  exit 43
fi

export INSTANCE_NAME WRKDIR DLC JAVA_HOME
if [ -n "$PARKBENCH_PAS_MAX_THREADS" ]; then
  export PASOE_MAX_THREADS="$PARKBENCH_PAS_MAX_THREADS"
fi

# The run supplies the database connection; nothing about the database is baked into the image.
/usr/local/bin/parkbench-pasoe-apply-db-connection.sh /deploy/scripts/config/runtime.properties

if [ ! -x /deploy/scripts/startServer.sh ]; then
  echo "pasoe_start_script_missing" >&2
  exit 44
fi
exec /deploy/scripts/startServer.sh
