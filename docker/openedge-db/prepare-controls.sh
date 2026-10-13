#!/bin/sh
# Offline BI preparation belongs to the copied run database, never to its seed.
set -eu
database_dir=$1
db_name=$2
run_id=${PARKBENCH_RUN_ID:-legacy-owned}
mode=${PARKBENCH_BI_CLUSTER_MODE:-inherit}
kib=${PARKBENCH_BI_CLUSTER_KIB:-}
case "$run_id:$db_name" in *[!a-zA-Z0-9_.:-]*) echo "database_bi_preparation_failed:identity_invalid" >&2; exit 54 ;; esac
case "$mode" in
  inherit) [ -z "$kib" ] || { echo "database_bi_preparation_failed:inherit_has_override" >&2; exit 54; } ;;
  override)
    case "$kib" in ''|*[!0-9]*|??????????*) echo "database_bi_preparation_failed:cluster_invalid" >&2; exit 54 ;; esac
    [ "$kib" -ge 16 ] && [ "$kib" -le 262128 ] && [ $((kib % 16)) -eq 0 ] || { echo "database_bi_preparation_failed:cluster_invalid" >&2; exit 54; } ;;
  *) echo "database_bi_preparation_failed:mode_invalid" >&2; exit 54 ;;
esac
cd "$database_dir"
identity=.parkbench-bi-identity.pending
printf '%s\n' "$run_id" "$db_name" "$mode" "$kib" "${PARKBENCH_DATABASE_RUN_CONTROLS:-}" "${PARKBENCH_OPENEDGE_DB_STARTUP_WORDS:-}" > "$identity"
if [ -n "${PARKBENCH_DATABASE_ARGV_FILE:-}" ]; then
  [ -f "$PARKBENCH_DATABASE_ARGV_FILE" ] || { echo "database_bi_preparation_failed:argv_missing" >&2; exit 54; }
  cat "$PARKBENCH_DATABASE_ARGV_FILE" >> "$identity"
fi
if [ -f .parkbench-bi-prepared ]; then
  if [ "$(cat "$identity")" != "$(cat .parkbench-bi-prepared)" ]; then
    rm -f "$identity"
    echo "database_bi_preparation_failed:identity_mismatch" >&2; exit 54
  fi
  if [ -f preparation.json ]; then rm -f "$identity"; exit 0; fi
fi
if [ -f .parkbench-broker-used ] && [ "$mode" = override ]; then
  rm -f "$identity"
  echo "database_bi_preparation_failed:already_used" >&2; exit 54
fi
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
write_status() {
  status=$1
  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  finished="\"$stamp\""
  [ "$status" != pending ] || finished=null
  native=''
  if [ "$mode" = override ]; then native=",\"nativeClusterKiB\":$kib"; fi
  printf '{"contractVersion":"db-preparation.v1","runId":"%s","databaseName":"%s","status":"%s","mode":"%s","capturedAt":"%s","startedAt":"%s","finishedAt":%s,"logReference":"bi-preparation.log"%s}\n' "$run_id" "$db_name" "$status" "$mode" "$stamp" "$started_at" "$finished" "$native" > preparation.json.tmp
  mv preparation.json.tmp preparation.json
}
if [ "$mode" = inherit ]; then
  write_status not_requested
else
  write_status pending
  if ! proutil "$db_name" -C truncate bi -bi "$kib" > bi-preparation.log 2>&1; then
    write_status failed
    rm -f "$identity"
    echo "database_bi_preparation_failed:native_truncate:bi-preparation.log" >&2; exit 54
  fi
  write_status prepared
fi
mv "$identity" .parkbench-bi-prepared
