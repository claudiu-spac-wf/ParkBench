#!/bin/sh
# Sets the ABL application DB connection from the run before the PAS instance is deployed.
# The PAS base deploy (set-runtime-property.xml, target tailorDatabaseProps) copies each
# <ablapp>.DB.CONNECTION.PARAMS value into that application's conf/startup.pf.
# Usage: apply-db-connection.sh [runtime.properties]
set -eu

properties=${1:-/deploy/scripts/config/runtime.properties}
connection=${PARKBENCH_PAS_DB_CONNECTION:-}
if [ -z "$connection" ]; then
  echo "pas_db_connection_unset" >&2
  exit 45
fi
case "$connection" in
  *"
"*) echo "pas_db_connection_invalid" >&2; exit 45 ;;
esac

temporary=$(mktemp)
awk -v connection="$connection" '
  { sub(/\r$/, "") }
  /^(oepas1|parkbench)\.DB\.CONNECTION\.PARAMS=/ {
    split($0, parts, "=")
    seen[parts[1]] = 1
    print parts[1] "=" connection
    next
  }
  { print }
  END {
    if (!("oepas1.DB.CONNECTION.PARAMS" in seen)) print "oepas1.DB.CONNECTION.PARAMS=" connection
    if (!("parkbench.DB.CONNECTION.PARAMS" in seen)) print "parkbench.DB.CONNECTION.PARAMS=" connection
  }
' "$properties" > "$temporary"
cat "$temporary" > "$properties"
rm -f "$temporary"
