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
capture_sequence=0
capture_outcome=MISSING
capture_exit=null
capture_start=null
capture_end=null
capture_duration=0
last_success=null
last_success_ms=null
capture_timed_out=false
process_checks='[]'
capture() {
  capture_sequence=$((capture_sequence + 1))
  prefix="$database_dir/startup-state.capture-$$-$capture_sequence"
  marker="$prefix.started"
  : > "$marker"
  capture_start="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  start_ms=$(date +%s%3N)
  capture_exit=0; capture_outcome=SUCCEEDED; capture_timed_out=false
  # Fresh output paths prevent an unsuccessful native call from reusing old health.
  timeout -k 2 15 mpro -b -T "$database_dir" -db "$database_dir/$db_name" -ld pbcompile -p "$procedure" -param "$prefix" >> startup-state.log 2>&1 || capture_exit=$?
  end_ms=$(date +%s%3N)
  capture_end="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  capture_duration=$((end_ms - start_ms))
  # Keep the native diagnostic tail bounded even over a long run.
  tail -c 65536 startup-state.log > startup-state.log.tail && mv startup-state.log.tail startup-state.log
  case "$capture_exit" in
    0) ;; 124) capture_outcome=TIMEOUT; capture_timed_out=true ;;
    137) capture_outcome=EXIT_FAILED; if [ "$capture_duration" -ge 15000 ]; then capture_outcome=TIMEOUT; capture_timed_out=true; fi ;;
    *) capture_outcome=EXIT_FAILED ;;
  esac
  if [ "$capture_outcome" = SUCCEEDED ]; then
    if [ ! -s "$prefix.env" ] || [ ! -s "$prefix.json" ]; then capture_outcome=MISSING
    elif [ "$marker" -nt "$prefix.env" ] || [ "$marker" -nt "$prefix.json" ]; then capture_outcome=STALE
    elif [ "$(wc -c < "$prefix.env")" -gt 4096 ] || [ "$(wc -c < "$prefix.json")" -gt 16384 ] ||
      ! parse_capture "$prefix.env" || ! validate_capture_json "$prefix.json"; then capture_outcome=MALFORMED
    fi
  fi
  rm -f "$marker"
  if [ "$capture_outcome" != SUCCEEDED ]; then rm -f "$prefix.env" "$prefix.json" "$prefix.env.tmp" "$prefix.json.tmp"; return 1; fi
  mv "$prefix.env" startup-state.env
  mv "$prefix.json" startup-state.json
}
validate_capture_json() {
  # Parse the entire fresh document, not just its version marker. Tie it to the
  # same capture's scalar/PID projection before embedding it in health evidence.
  jq -e -s --argjson cluster "$clusterKiB" --argjson buffers "$biBuffers" --argjson capacity "$capacity" \
    --argjson apws "$apwCount" --argjson biws "$biwCount" --arg apids "$apwPids" --arg bpids "$biwPids" '
    length == 1 and (.[0] | type == "object" and .contractVersion == "db-startup-state.v1" and
    (.capturedAt | type == "string") and .nativeClusterKiB == $cluster and
    .biBuffers == $buffers and .connectionCapacity == $capacity and
    .apwCount == $apws and .biwCount == $biws and
    (.writers | type == "array" and length <= 10 and length == ($apws + $biws)) and
    all(.writers[]; (.pid | type == "number" and . > 1 and floor == .) and
      (.type == "APW" or .type == "BIW")) and
    ([.writers[] | select(.type == "APW") | .pid | tostring] | join(",")) == $apids and
    ([.writers[] | select(.type == "BIW") | .pid | tostring] | join(",")) == $bpids)
  ' "$1" >/dev/null 2>&1
}
parse_capture() {
  clusterKiB=; biBuffers=; capacity=; apwCount=; biwCount=; apwPids=; biwPids=
  while IFS='=' read -r name value; do
    case "$value" in *[!0-9,]*) return 1 ;; esac
    case "$name" in
      clusterKiB) clusterKiB=$value ;; biBuffers) biBuffers=$value ;; capacity) capacity=$value ;;
      apwCount) apwCount=$value ;; biwCount) biwCount=$value ;; apwPids) apwPids=$value ;; biwPids) biwPids=$value ;;
      *) return 1 ;;
    esac
  done < "$1"
  for numeric in "$clusterKiB" "$biBuffers" "$capacity" "$apwCount" "$biwCount"; do
    case "$numeric" in ''|*[!0-9]*|??????????*) return 1 ;; esac
  done
  [ "$clusterKiB" -ge 16 ] && [ "$biBuffers" -ge 3 ] && [ "$apwCount" -le 9 ] && [ "$biwCount" -le 1 ] || return 1
}
evidence() {
  verification=$1; health=$2; reason=$3
  last_success_age=null
  if [ "$last_success_ms" != null ]; then last_success_age=$(($(date +%s%3N) - last_success_ms)); fi
  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  observed=null; if [ "$capture_outcome" = SUCCEEDED ] && [ -f startup-state.json ]; then observed=$(cat startup-state.json); fi
  last_observation=null; if [ "$last_success" != null ] && [ -f .parkbench-last-good-startup-state.json ]; then last_observation=$(cat .parkbench-last-good-startup-state.json); fi
  preparation=null; [ ! -f preparation.json ] || preparation=$(cat preparation.json)
  printf '{"contractVersion":"db-run-controls-evidence.v1","capturedAt":"%s","verification":"%s","writerHealth":"%s","reason":"%s","lastSuccessAt":%s,"expected":{"apwCount":%s,"biwCount":%s,"nativeClusterKiB":%s,"biBuffers":%s,"minimumConnectionCapacity":%s},"observed":%s,"preparation":%s,"capture":{"outcome":"%s","startedAt":%s,"finishedAt":%s,"durationMs":%s,"exitCode":%s,"lastSuccessAt":%s,"lastSuccessAgeMs":%s,"timedOut":%s,"logRef":"startup-state.log"},"processChecks":%s,"lastSuccessfulObservation":%s,"logs":["startup-state.log","writer-start.log","bi-preparation.log"]}\n' "$stamp" "$verification" "$health" "$reason" "${last_success:-null}" "$expected_apws" "$expected_biws" "${expected_cluster:-null}" "${expected_buffers:-null}" "$((required + expected_apws + expected_biws))" "$observed" "$preparation" "$capture_outcome" "$capture_start" "$capture_end" "$capture_duration" "$capture_exit" "$last_success" "$last_success_age" "$capture_timed_out" "$process_checks" "$last_observation" > database-run-controls.json.tmp
  mv database-run-controls.json.tmp database-run-controls.json
}
fail() { : > .parkbench-controls-failed; trap '' TERM INT; evidence "$2" "$3" "$1"; echo "$1:database-run-controls.json" >&2; exit 55; }
[ ! -f .parkbench-controls-failed ] || exit 55
capture || fail database_run_control_unapplied unavailable unavailable
if [ "$apwCount" -ne 0 ] || [ "$biwCount" -ne 0 ]; then fail database_run_control_unapplied mismatched unavailable; fi
total_required=$((required + expected_apws + expected_biws))
[ "$capacity" -ge "$total_required" ] || fail database_writer_capacity_insufficient mismatched unavailable
[ -z "$expected_cluster" ] || [ "$clusterKiB" = "$expected_cluster" ] || fail database_run_control_unapplied mismatched unavailable
[ -z "$expected_buffers" ] || [ "$biBuffers" = "$expected_buffers" ] || fail database_run_control_unapplied mismatched unavailable
identity_check() {
  pids=$1; type=$2; expected=$3; count=0; identities_ok=true
  previous_ifs=$IFS; IFS=,
  for pid in $pids; do
    count=$((count + 1))
    args=$(ps -p "$pid" -o args= 2>/dev/null) || args=
    start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null) || start=
    case "$start" in ''|*[!0-9]*) start= ;; esac
    old_start=
    if [ -f .parkbench-writer-identities ]; then old_start=$(awk -F '|' -v pid="$pid" '$1==pid {print $2}' .parkbench-writer-identities); fi
    matched=false
    case "$args" in *"_mprshut $database_dir/$db_name -C $type"*)
      if [ -n "$start" ] && { [ -z "$old_start" ] || [ "$start" = "$old_start" ]; }; then matched=true; fi ;;
    esac
    check_reason=MATCHED
    if [ "$matched" != true ]; then
      identities_ok=false
      if { [ -z "$start" ] && [ ! -d "/proc/$pid" ] && [ -z "$args" ]; } || { [ -n "$old_start" ] && [ -n "$start" ] && [ "$start" != "$old_start" ]; }; then check_reason=LOST_OR_REPLACED; loss_demonstrated=true
      elif [ -n "$args" ] && [ -n "$start" ]; then check_reason=LOST_OR_REPLACED; loss_demonstrated=true
      else check_reason=UNAVAILABLE
      fi
    fi
    case "$type" in apw) process_type=APW ;; biw) process_type=BIW ;; esac
    item=$(printf '{"type":"%s","pid":%s,"startIdentity":%s,"expectedStartIdentity":%s,"matched":%s,"checkedAt":"%s","reason":"%s"}' "$process_type" "$pid" "${start:-null}" "${old_start:-null}" "$matched" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$check_reason")
    process_checks="${process_checks%]}${process_checks_separator:-}$item]"; process_checks_separator=,
  done
  IFS=$previous_ifs
  [ "$count" -eq "$expected" ] && [ "$identities_ok" = true ]
}
check_owned_processes() {
  process_checks='[]'; process_checks_separator=; loss_demonstrated=false
  identity_check "$owned_apws" apw "$expected_apws" && identity_check "$owned_biws" biw "$expected_biws"
}
index=0
while [ "$index" -lt "$expected_apws" ]; do
  proapw "$database_dir/$db_name" >> writer-start.log 2>&1 || fail database_writer_start_failed mismatched unavailable
  index=$((index + 1))
done
if [ "$expected_biw" = true ]; then
  probiw "$database_dir/$db_name" >> writer-start.log 2>&1 || fail database_writer_start_failed mismatched unavailable
fi
rm -f .parkbench-writer-identities
attempt=0
while :; do
  process_checks='[]'; process_checks_separator=
  if capture && [ "$apwCount" -eq "$expected_apws" ] && [ "$biwCount" -eq "$expected_biws" ] &&
    identity_check "$apwPids" apw "$expected_apws" && identity_check "$biwPids" biw "$expected_biws"; then break; fi
  attempt=$((attempt + 1)); [ "$attempt" -lt 10 ] || fail database_writer_start_failed mismatched unavailable
  sleep 1
done
owned_apws=$apwPids; owned_biws=$biwPids
printf '%s\n%s\n' "$owned_apws" "$owned_biws" > .parkbench-owned-writers
old_ifs=$IFS; IFS=,
all_owned_pids="$owned_apws,$owned_biws"
for pid in $all_owned_pids; do
  [ -n "$pid" ] || continue
  start=$(awk '{print $22}' "/proc/$pid/stat")
  printf '%s|%s\n' "$pid" "$start" >> .parkbench-writer-identities
 done
IFS=$old_ifs
cp startup-state.json .parkbench-last-good-startup-state.json.tmp
mv .parkbench-last-good-startup-state.json.tmp .parkbench-last-good-startup-state.json
last_success="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
last_success_ms=$(date +%s%3N)
evidence matched verified ''
: > .parkbench-controls-ready
planned_stop() { trap '' TERM INT; [ ! -f .parkbench-controls-failed ] || exit 0; evidence matched stopped planned_shutdown; exit 0; }
trap planned_stop TERM INT
while :; do
  sleep 5
  if ! capture; then
    if ! check_owned_processes && [ "$loss_demonstrated" = true ]; then fail database_writer_lost mismatched lost; fi
    fail database_writer_health_unavailable unavailable unavailable
  fi
  process_checks='[]'; process_checks_separator=
  # Native inventory order is stable by _Connect row; counts plus retained PIDs reject replacements.
  [ "$apwCount" -eq "$expected_apws" ] && [ "$biwCount" -eq "$expected_biws" ] &&
    [ "$apwPids" = "$owned_apws" ] && [ "$biwPids" = "$owned_biws" ] || fail database_writer_lost mismatched lost
  if ! check_owned_processes; then
    if [ "$loss_demonstrated" = true ]; then fail database_writer_lost mismatched lost; fi
    fail database_writer_health_unavailable unavailable unavailable
  fi
  cp startup-state.json .parkbench-last-good-startup-state.json.tmp
mv .parkbench-last-good-startup-state.json.tmp .parkbench-last-good-startup-state.json
last_success="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
last_success_ms=$(date +%s%3N)
  evidence matched verified ''
done
