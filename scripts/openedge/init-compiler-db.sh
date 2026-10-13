#!/bin/sh
set -eu
# Compilation needs definitions only. All extents are freshly created in the owned volume.
cd /psc/wrk
mkdir -p "$DB_NAME"
cd "$DB_NAME"
prostrct create "$DB_NAME" /parkbench/compiler.st -blocksize 8192
procopy "$DLC/prolang/utf/empty8" "$DB_NAME"
"$DLC/bin/_progres" -b -1 -db "$DB_NAME" -B 1024 -cpinternal UTF-8 -cpstream UTF-8 \
  -p /parkbench/load-compiler-schema.p -param /parkbench/compiler.df
if [ "$(cat .parkbench-schema-loaded 2>/dev/null)" != OK ]; then
  echo compiler_schema_load_failed >&2
  exit 54
fi
export PARKBENCH_DB_INIT_MODE=empty
export PARKBENCH_OPENEDGE_DB_STARTUP_WORDS='-B=1024'
exec /usr/local/bin/parkbench-db-entrypoint.sh
