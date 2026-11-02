#!/bin/sh
set -eu
set_directory=$1
set_record=${2:-}
transcript=$(cat "$set_directory/transcript-version")
. "$set_directory/argv.sh"
if [ "$transcript" = none ]; then exec proutil "$@" < "$set_directory/stdin"; fi
# Some can reject a target yet continue with earlier valid selections. Retain that
# native diagnostic as a failed set rather than accepting a partial requested scope.
proutil "$@" < "$set_directory/stdin" &
utility_pid=$!
trap 'kill -TERM "$utility_pid" 2>/dev/null || true; wait "$utility_pid" 2>/dev/null || true; exit 72' TERM INT
native_exit=0
wait "$utility_pid" || native_exit=$?
[ "$native_exit" -eq 0 ] || exit "$native_exit"
if [ -n "$set_record" ] && grep -q '^ERROR -' "$set_record.stdout"; then
  echo database_setup_failed:selected_index_target_rejected >&2
  exit 2
fi
