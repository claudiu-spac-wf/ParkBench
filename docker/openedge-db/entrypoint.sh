#!/bin/sh
set -eu

if [ -z "${DB_NAME:-}" ]; then
  echo "db_name_unset" >&2
  exit 41
fi
: "${DB_BROKER_PORT:=20931}"
: "${DB_MINPORT:=20932}"
: "${DB_MAXPORT:=20941}"
: "${PARKBENCH_DB_WORKDIR:=/psc/wrk}"
: "${PARKBENCH_DB_INIT_MODE:=seed}"

case "$DB_NAME" in *[!a-zA-Z0-9_-]*|'') echo "db_name_invalid" >&2; exit 41 ;; esac

case "${PARKBENCH_DATABASE_READ_ONLY:-false}" in
  true|TRUE|1) echo "network_broker_read_only_not_supported" >&2; exit 42 ;;
esac

database_dir="$PARKBENCH_DB_WORKDIR/$DB_NAME"
mkdir -p "$database_dir"
supervisor_pid=
broker_started=false
shutdown() {
  trap - EXIT TERM INT
  if [ -n "$supervisor_pid" ]; then kill -TERM "$supervisor_pid" 2>/dev/null || true; wait "$supervisor_pid" 2>/dev/null || true; fi
  if [ "$broker_started" = true ]; then proshut -by "$database_dir/$DB_NAME" || true; fi
}
trap shutdown EXIT
trap 'shutdown; exit 0' TERM INT
case "$PARKBENCH_DB_INIT_MODE" in
  seed)
    # Run and compile mode: copy the read-only seed mounted at /run/parkbench/seed/db into the
    # container's volume.
    /usr/local/bin/parkbench-db-copy-seed.sh "${PARKBENCH_SEED_DB_DIR:-/run/parkbench/seed/db}" "$database_dir" "$DB_NAME"
    ;;
  empty)
    # Compile mode for VST-only procedures (the DB observer): an empty UTF-8 database.
    if [ ! -f "$database_dir/$DB_NAME.db" ]; then
      (cd "$database_dir" && procopy "$DLC/prolang/utf/empty8" "$DB_NAME" >/dev/null) || {
        echo "schema_db_create_failed" >&2
        exit 53
      }
    fi
    ;;
  *) echo "db_init_mode_invalid:$PARKBENCH_DB_INIT_MODE" >&2; exit 41 ;;
esac
printf '%s\n' "${DB_NAME}" > "$database_dir/.parkbench-db-name"

if [ -n "${PARKBENCH_DATABASE_RUN_CONTROLS:-}" ]; then
  /usr/local/bin/parkbench-db-prepare-controls.sh "$database_dir" "$DB_NAME"
fi

# The upstream init.sh recreates a sample database and its startup script only
# consumes /deploy/scripts/config/startup.pf. Start the run database directly so
# the reviewed run settings reach the primary broker.
cd "$database_dir"
set -- "$DB_NAME"
# The controller parses controlled PF inputs and freezes their effective literal tokens.
# Never reopen an unchecked copied PF at native startup.
set -- "$@" -S "$DB_BROKER_PORT" -minport "$DB_MINPORT" -maxport "$DB_MAXPORT"
# VST _TableStat/_IndexStat only cover tables and indexes inside these ranges (default 50).
# Match the seed label caps (64 tables, 256 indexes) so every labelled object is measured.
set -- "$@" -tablerangesize "${PARKBENCH_DB_TABLE_RANGE_SIZE:-64}" -indexrangesize "${PARKBENCH_DB_INDEX_RANGE_SIZE:-256}"
if [ -n "${PARKBENCH_DATABASE_ARGV_FILE:-}" ]; then
  if [ ! -f "$PARKBENCH_DATABASE_ARGV_FILE" ]; then echo "database_argv_missing" >&2; exit 43; fi
  if [ -f /run/parkbench/broker-directories ]; then
    while IFS= read -r directory || [ -n "$directory" ]; do
      case "$directory" in "$database_dir"|"$database_dir"/*) mkdir -p "$directory" ;; *) echo "database_parameter_ownership:directory" >&2; exit 43 ;; esac
    done < /run/parkbench/broker-directories
  fi
  while IFS= read -r token || [ -n "$token" ]; do
    set -- "$@" "$token"
  done < "$PARKBENCH_DATABASE_ARGV_FILE"
fi
rm -f .parkbench-controls-ready
# Persist before launch: even a failed broker may have changed the BI file.
if [ -n "${PARKBENCH_DATABASE_RUN_CONTROLS:-}" ]; then printf '%s\n' "${PARKBENCH_RUN_ID:-legacy-owned}" > .parkbench-broker-used; fi
broker_started=true
proserve "$@"
attempt=0
until pgrep -x _mprosrv >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "database_broker_start_failed" >&2
    exit 52
  fi
  sleep 1
done
if [ -n "${PARKBENCH_DATABASE_RUN_CONTROLS:-}" ]; then
  /usr/local/bin/parkbench-db-controls-lifecycle.sh "$database_dir" "$DB_NAME" &
  supervisor_pid=$!
  wait "$supervisor_pid"
else
  tail -f /dev/null &
  supervisor_pid=$!
  wait "$supervisor_pid"
fi
