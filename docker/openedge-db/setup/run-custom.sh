#!/bin/sh
# Transparent designated-primary launcher: preserve argv, streams, CWD and final status.
set -u
: "${PARKBENCH_PRIMARY_RECORD:?primary record is required}"
printf '%s\n' observed > "$PARKBENCH_PRIMARY_RECORD.primary-observed.tmp" && mv "$PARKBENCH_PRIMARY_RECORD.primary-observed.tmp" "$PARKBENCH_PRIMARY_RECORD.primary-observed" || exit 70
"$@"
primary_exit=$?
printf '%s\n' "$primary_exit" > "$PARKBENCH_PRIMARY_RECORD.primary-exit.tmp" && mv "$PARKBENCH_PRIMARY_RECORD.primary-exit.tmp" "$PARKBENCH_PRIMARY_RECORD.primary-exit" || exit 70
exit "$primary_exit"
