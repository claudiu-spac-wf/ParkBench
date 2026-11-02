#!/bin/sh
set -eu
setup_input=${PARKBENCH_SETUP_INPUT:-/run/parkbench/setup-input}
setup_output=${PARKBENCH_SETUP_OUTPUT:-/run/parkbench/setup-output}
setup_control=${PARKBENCH_SETUP_CONTROL:-/run/parkbench/setup-control}
setup_helpers=${PARKBENCH_SETUP_HELPERS:-/usr/local/lib/parkbench/setup}
[ -r "$setup_input/identity.sh" ] || { echo database_setup_unavailable:identity >&2; exit 70; }
. "$setup_input/identity.sh"
case "$setup_run_id:$setup_attempt_id" in *[!a-zA-Z0-9_:-]*|'') echo database_setup_evidence_invalid:identity >&2; exit 70 ;; esac
[ "$setup_run_id" = "${PARKBENCH_RUN_ID:-}" ] && [ "$setup_attempt_id" = "${PARKBENCH_SETUP_ATTEMPT_ID:-}" ] || { echo database_setup_evidence_invalid:owner >&2; exit 70; }
. "$setup_helpers/write-status.sh"
export PARKBENCH_SETUP_HELPERS="$setup_helpers"
step_number=0; set_number=0
case "${1:-}" in
  claim)
    if ! mkdir "$setup_control/started" 2>/dev/null; then
      echo database_setup_replay_refused >&2
      setup_status FAILED preparing null database_setup_replay_refused || true
      exit 71
    fi
    setup_now > "$setup_output/started-at"
    setup_status RUNNING preparing
    if [ "${setup_custom_requested:-false}" = true ]; then
      if ! "$setup_helpers/custom-supervisor" --check; then setup_status FAILED preparing null database_setup_unavailable; exit 75; fi
    fi
    exit 0 ;;
  wait)
    while :; do
      if setup_cancelled; then setup_status CANCELLED awaiting-normal-start; exit 72; fi
      if [ -f "$setup_control/normal-start-release" ]; then
        expected="$setup_run_id:$setup_attempt_id"
        [ "$(cat "$setup_control/normal-start-release")" = "$expected" ] || { echo database_setup_evidence_invalid:release >&2; exit 70; }
        setup_cancelled && { setup_status CANCELLED awaiting-normal-start; exit 72; }
        setup_status SUCCEEDED released 0
        exit 0
      fi
      sleep 1
    done ;;
  execute) ;;
  *) echo database_setup_unavailable:mode >&2; exit 70 ;;
esac
maintenance=false
child_pid=
cleanup_maintenance() {
  [ "$maintenance" = true ] || return 0
  setup_status RUNNING temporary-shutdown || return 70
  shutdown_result=0
  proshut "$DB_NAME" -by > "$step_output/shutdown.stdout" 2> "$step_output/shutdown.stderr" || shutdown_result=$?
  printf '%s\n' "$shutdown_result" > "$step_output/shutdown.exit"
  attempt=0
  while :; do
    busy_result=0; proutil "$DB_NAME" -C busy >/dev/null 2>&1 || busy_result=$?
    if [ "$busy_result" -eq 0 ] && ! pgrep -x _mprosrv >/dev/null 2>&1; then maintenance=false; printf '%s\n' confirmed > "$step_output/shutdown.confirmed"; return "$shutdown_result"; fi
    attempt=$((attempt + 1)); [ "$attempt" -lt "${PARKBENCH_SETUP_PROBE_ATTEMPTS:-60}" ] || { echo database_setup_shutdown_unconfirmed >&2; return 73; }
    sleep 1
  done
}
stop_setup() {
  trap - TERM INT
  if [ -n "$child_pid" ]; then kill -TERM "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; fi
  if [ -n "${set_output:-}" ] && [ -n "${set_started:-}" ]; then setup_set_status CANCELLED || true; fi
  cleanup_maintenance || true
  setup_status CANCELLED utility || true
  exit 72
}
trap stop_setup TERM INT
run_child() {
  "$@" & child_pid=$!
  while kill -0 "$child_pid" 2>/dev/null; do
    if setup_cancelled; then stop_setup; fi
    if [ "${definition:-}" = custom ]; then
      if ! setup_set_status RUNNING; then kill -TERM "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; child_pid=; return 70; fi
      if [ -f "$set_output.shell-exit" ]; then
        if ! setup_status RUNNING waiting-processes; then kill -TERM "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; child_pid=; return 70; fi
      fi
    fi
    sleep 1
  done
  child_result=0; wait "$child_pid" || child_result=$?; child_pid=
  return "$child_result"
}
step_number=1
while [ "$step_number" -le "$setup_step_count" ]; do
  step_ordinal=$(printf '%04d' "$step_number")
  step_input="$setup_input/steps/$step_ordinal"
  step_output="$setup_output/steps/$step_ordinal"
  mkdir -p "$step_output"
  . "$step_input/step.sh"
  case "$definition" in idxbuild|idxcompact|tablereorg|custom) ;; *) echo database_setup_unavailable:definition >&2; exit 70 ;; esac
  set_number=0
  setup_cancelled && stop_setup
  setup_status RUNNING step-running
  if [ "$definition" = tablereorg ]; then
    setup_status RUNNING temporary-startup
    maintenance=true
    start_result=0
    proserve "$DB_NAME" -cpinternal UTF-8 -S "${DB_BROKER_PORT:-20931}" -minport "${DB_MINPORT:-20932}" -maxport "${DB_MAXPORT:-20941}" > "$step_output/startup.stdout" 2> "$step_output/startup.stderr" || start_result=$?
    printf '%s\n' "$start_result" > "$step_output/startup.exit"
    if [ "$start_result" -ne 0 ]; then cleanup_maintenance || true; setup_status FAILED temporary-startup "$start_result" database_setup_start_failed; exit "$start_result"; fi
    attempt=0
    while :; do
      setup_cancelled && stop_setup
      busy_result=0; proutil "$DB_NAME" -C busy >/dev/null 2>&1 || busy_result=$?
      if [ "$busy_result" -eq 6 ] && pgrep -x _mprosrv >/dev/null 2>&1 && mpro -b -db "$DB_NAME" -p "$setup_helpers/probe.p" >> "$step_output/startup.stdout" 2>> "$step_output/startup.stderr"; then break; fi
      attempt=$((attempt + 1)); [ "$attempt" -lt "${PARKBENCH_SETUP_PROBE_ATTEMPTS:-60}" ] || { cleanup_maintenance || true; setup_status FAILED temporary-startup null database_setup_start_failed; exit 74; }
      sleep 1
    done
    pgrep -x _mprosrv > "$step_output/broker.pids"
    setup_status RUNNING temporary-ready
  fi
  set_number=1
  while [ "$set_number" -le "$set_count" ]; do
    setup_cancelled && stop_setup
    set_ordinal=$(printf '%04d' "$set_number")
    set_input="$step_input/$set_ordinal"
    set_output="$step_output/$set_ordinal"
    set_started=$(setup_now)
    setup_set_status RUNNING
    setup_status RUNNING utility
    native_result=0
    run_child sh "$setup_helpers/$definition.sh" "$set_input" "$set_output" > "$set_output.stdout" 2> "$set_output.stderr" || native_result=$?
    if [ "$native_result" -ne 0 ]; then
      setup_set_status FAILED "$native_result"
      cleanup_maintenance || true
      failure_code=database_setup_failed
      if [ "$definition" = custom ]; then
        if [ ! -f "$set_output.process" ] || [ "$(cat "$set_output.process")" != QUIESCENT ]; then failure_code=database_setup_process_unconfirmed
        elif [ ! -f "$set_output.primary-observed" ] || [ ! -f "$set_output.primary-exit" ]; then failure_code=database_setup_evidence_invalid; fi
      fi
      setup_status FAILED utility "$native_result" "$failure_code"
      exit "$native_result"
    fi
    setup_set_status SUCCEEDED 0
    set_number=$((set_number + 1))
  done
  set_number=0
  if ! cleanup_maintenance; then setup_status FAILED temporary-shutdown null database_setup_shutdown_unconfirmed; exit 73; fi
  step_number=$((step_number + 1))
done
step_number=0; set_number=0
setup_now > "$setup_output/finished-at"
setup_status SUCCEEDED awaiting-normal-start 0
