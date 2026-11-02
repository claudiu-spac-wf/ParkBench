#!/bin/sh
# Fixed protocol fields only. User targets/options are joined from the frozen manifest.
setup_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
setup_status() {
  status_state=$1; status_phase=$2; status_exit=${3:-null}; status_code=${4:-none}
  case "$status_state" in PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED) ;; *) return 70 ;; esac
  case "$status_phase" in staged|preparing|step-running|temporary-startup|temporary-ready|utility|waiting-processes|temporary-shutdown|awaiting-normal-start|released|complete) ;; *) return 70 ;; esac
  case "$status_exit" in null|[0-9]|[0-9][0-9]|[0-9][0-9][0-9]) ;; *) return 70 ;; esac
  case "$status_code" in none|database_setup_unavailable|database_setup_failed|database_setup_start_failed|database_setup_shutdown_unconfirmed|database_setup_evidence_invalid|database_setup_process_unconfirmed|database_setup_replay_refused) ;; *) return 70 ;; esac
  status_stamp=$(setup_now) || return 70
  printf '{"contractVersion":"database-setup-status.v1","runId":"%s","attemptId":"%s","state":"%s","phase":"%s","step":%s,"optionSet":%s,"exitStatus":%s,"code":"%s","capturedAt":"%s"}\n' "$setup_run_id" "$setup_attempt_id" "$status_state" "$status_phase" "${step_number:-0}" "${set_number:-0}" "$status_exit" "$status_code" "$status_stamp" > "$setup_output/status.json.tmp" && mv "$setup_output/status.json.tmp" "$setup_output/status.json" || { echo database_setup_evidence_invalid:status_write >&2; return 70; }
}
setup_set_status() {
  set_state=$1; set_exit=${2:-null}
  custom_fields=
  if [ "${definition:-}" = custom ]; then
    primary_observed=false; primary_exit=null; shell_exit=null; scope=ACTIVE; quiescent=null
    [ ! -f "$set_output.primary-observed" ] || primary_observed=true
    if [ -f "$set_output.primary-exit" ]; then primary_exit=$(cat "$set_output.primary-exit"); fi
    if [ -f "$set_output.shell-exit" ]; then shell_exit=$(cat "$set_output.shell-exit"); fi
    for native_exit in "$primary_exit" "$shell_exit"; do case "$native_exit" in null|[0-9]|[0-9][0-9]|[0-9][0-9][0-9]) ;; *) echo database_setup_evidence_invalid:custom_exit >&2; return 70 ;; esac; done
    if [ -f "$set_output.process" ]; then scope=$(cat "$set_output.process"); fi
    case "$scope" in ACTIVE|QUIESCENT|UNCONFIRMED) ;; *) scope=UNCONFIRMED ;; esac
    if [ "$set_state" != RUNNING ] && [ "$scope" != QUIESCENT ]; then scope=UNCONFIRMED; fi
    if [ -f "$set_output.quiescent-at" ]; then
      stamp=$(cat "$set_output.quiescent-at")
      case "$stamp" in ''|*[!0-9TZ:.+-]*) return 70 ;; esac
      quiescent="\"$stamp\""
    fi
    if [ "$set_state" != RUNNING ]; then
      set_exit=null
      if [ "$primary_exit" != null ] && [ "$primary_exit" -ne 0 ]; then set_exit=$primary_exit
      elif [ "$shell_exit" != null ] && [ "$shell_exit" -ne 0 ]; then set_exit=$shell_exit
      elif [ "$primary_observed" = true ] && [ "$primary_exit" = 0 ] && [ "$shell_exit" = 0 ] && [ "$scope" = QUIESCENT ]; then set_exit=0; fi
    fi
    custom_fields=",\"primaryInvocationObserved\":$primary_observed,\"primaryExitStatus\":$primary_exit,\"shellExitStatus\":$shell_exit,\"processScopeState\":\"$scope\",\"quiescentAt\":$quiescent"
  fi
  set_finished=null
  if [ "$set_state" != RUNNING ]; then set_finished="\"$(setup_now)\""; fi
  printf '{"state":"%s","exitStatus":%s,"startedAt":"%s","finishedAt":%s%s}\n' "$set_state" "$set_exit" "$set_started" "$set_finished" "$custom_fields" > "$set_output.json.tmp" && mv "$set_output.json.tmp" "$set_output.json" || { echo database_setup_evidence_invalid:set_status_write >&2; return 70; }
}

setup_cancelled() { [ -f "$setup_control/cancel" ]; }
