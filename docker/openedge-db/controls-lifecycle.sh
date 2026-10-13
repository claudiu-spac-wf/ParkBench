#!/bin/sh
# Native ownership verification and ongoing supervision inside the private DB container.
set -eu
database_dir=$1
db_name=$2
cd "$database_dir"
expected_apws=${PARKBENCH_APW_COUNT:-0}
expected_biw=${PARKBENCH_BIW_ENABLED:-false}
expected_cluster=${PARKBENCH_BI_CLUSTER_KIB:-}
expected_buffers=${PARKBENCH_EXPECTED_BI_BUFFERS:-}
required=${PARKBENCH_REQUIRED_DATABASE_CONNECTIONS:-4}
case "$expected_apws" in [0-9]) ;; *) echo "database_run_control_invalid:apwCount" >&2; exit 55 ;; esac
case "$expected_biw" in true) expected_biws=1 ;; false) expected_biws=0 ;; *) echo "database_run_control_invalid:biwEnabled" >&2; exit 55 ;; esac
case "$required:$expected_buffers:$expected_cluster" in *[!0-9:]*) echo "database_run_control_invalid:capacity_or_buffers" >&2; exit 55 ;; esac
procedure=${PARKBENCH_DB_STARTUP_STATE_PROCEDURE:-/usr/local/lib/parkbench/parkbench-db-startup-state.r}
capture() {
  rm -f startup-state.env
  # The VST-only procedure is compiled against this fixed logical DB name; the physical DB is run-owned.
  timeout 15 mpro -b -T "$database_dir" -db "$database_dir/$db_name" -ld pbcompile -p "$procedure" -param "$database_dir/startup-state" >> startup-state.log 2>&1 || return 1
  [ -f startup-state.env ] && [ -f startup-state.json ] || return 1
  clusterKiB=; biBuffers=; capacity=; apwCount=; biwCount=; apwPids=; biwPids=
  while IFS='=' read -r name value; do
    case "$value" in *[!0-9,]*) return 1 ;; esac
    case "$name" in
      clusterKiB) clusterKiB=$value ;; biBuffers) biBuffers=$value ;; capacity) capacity=$value ;;
      apwCount) apwCount=$value ;; biwCount) biwCount=$value ;; apwPids) apwPids=$value ;; biwPids) biwPids=$value ;;
      *) return 1 ;;
    esac
  done < startup-state.env
  for numeric in "$clusterKiB" "$biBuffers" "$capacity" "$apwCount" "$biwCount"; do
    case "$numeric" in ''|*[!0-9]*|??????????*) return 1 ;; esac
  done
  [ "$clusterKiB" -ge 16 ] && [ "$biBuffers" -ge 3 ] && [ "$apwCount" -le 9 ] && [ "$biwCount" -le 1 ] || return 1
}
evidence() {
  verification=$1; health=$2; reason=$3
  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  observed=null; [ ! -f startup-state.json ] || observed=$(cat startup-state.json)
  preparation=null; [ ! -f preparation.json ] || preparation=$(cat preparation.json)
  printf '{"contractVersion":"db-run-controls-evidence.v1","capturedAt":"%s","verification":"%s","writerHealth":"%s","reason":"%s","lastSuccessAt":%s,"expected":{"apwCount":%s,"biwCount":%s,"nativeClusterKiB":%s,"biBuffers":%s,"minimumConnectionCapacity":%s},"observed":%s,"preparation":%s,"logs":["startup-state.log","writer-start.log","bi-preparation.log"]}\n' "$stamp" "$verification" "$health" "$reason" "${last_success:-null}" "$expected_apws" "$expected_biws" "${expected_cluster:-null}" "${expected_buffers:-null}" "$((required + expected_apws + expected_biws))" "$observed" "$preparation" > database-run-controls.json.tmp
  mv database-run-controls.json.tmp database-run-controls.json
}
fail() { evidence "$2" "$3" "$1"; echo "$1:database-run-controls.json" >&2; exit 55; }
capture || fail database_run_control_unapplied unavailable unavailable
if [ "$apwCount" -ne 0 ] || [ "$biwCount" -ne 0 ]; then fail database_run_control_unapplied mismatched unavailable; fi
total_required=$((required + expected_apws + expected_biws))
[ "$capacity" -ge "$total_required" ] || fail database_writer_capacity_insufficient mismatched unavailable
[ -z "$expected_cluster" ] || [ "$clusterKiB" = "$expected_cluster" ] || fail database_run_control_unapplied mismatched unavailable
[ -z "$expected_buffers" ] || [ "$biBuffers" = "$expected_buffers" ] || fail database_run_control_unapplied mismatched unavailable
identity_check() {
  pids=$1; type=$2; expected=$3; count=0
  previous_ifs=$IFS; IFS=,
  for pid in $pids; do
    count=$((count + 1))
    args=$(ps -p "$pid" -o args=) || { IFS=$previous_ifs; return 1; }
    case "$args" in *"_mprshut $database_dir/$db_name -C $type"*) ;; *) IFS=$previous_ifs; return 1 ;; esac
  done
  IFS=$previous_ifs
  [ "$count" -eq "$expected" ]
}
index=0
while [ "$index" -lt "$expected_apws" ]; do
  proapw "$database_dir/$db_name" >> writer-start.log 2>&1 || fail database_writer_start_failed mismatched unavailable
  index=$((index + 1))
done
if [ "$expected_biw" = true ]; then
  probiw "$database_dir/$db_name" >> writer-start.log 2>&1 || fail database_writer_start_failed mismatched unavailable
fi
attempt=0
while :; do
  if capture && [ "$apwCount" -eq "$expected_apws" ] && [ "$biwCount" -eq "$expected_biws" ] &&
    identity_check "$apwPids" apw "$expected_apws" && identity_check "$biwPids" biw "$expected_biws"; then break; fi
  attempt=$((attempt + 1)); [ "$attempt" -lt 10 ] || fail database_writer_start_failed mismatched unavailable
  sleep 1
done
owned_apws=$apwPids; owned_biws=$biwPids
printf '%s\n%s\n' "$owned_apws" "$owned_biws" > .parkbench-owned-writers
last_success="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
evidence matched verified ''
: > .parkbench-controls-ready
planned_stop() { evidence matched stopped planned_shutdown; exit 0; }
trap planned_stop TERM INT
while :; do
  sleep 5
  capture || fail database_writer_lost unavailable unavailable
  # Native inventory order is stable by _Connect row; counts plus retained PIDs reject replacements.
  [ "$apwCount" -eq "$expected_apws" ] && [ "$biwCount" -eq "$expected_biws" ] &&
    [ "$apwPids" = "$owned_apws" ] && [ "$biwPids" = "$owned_biws" ] &&
    identity_check "$apwPids" apw "$expected_apws" && identity_check "$biwPids" biw "$expected_biws" || fail database_writer_lost mismatched lost
  last_success="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  evidence matched verified ''
done
