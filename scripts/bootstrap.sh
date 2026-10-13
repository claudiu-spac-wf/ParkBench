#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
attempt_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
data_root="${PARKBENCH_HOST_DATA_ROOT:-.parkbench}"
if ! data_root="$(node "$SCRIPT_DIR/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$data_root" 2>/dev/null)"; then
  data_root="$ROOT_DIR/.parkbench"
fi
log_dir="$data_root/bootstrap"
echo "making dir $log_dir"
mkdir -p "$log_dir"


chmod 700 "$log_dir" 2>/dev/null || true
diagnostic_log="$log_dir/attempt-$attempt_id.log"
: > "$diagnostic_log"
chmod 600 "$diagnostic_log"

stage="started"
component="bootstrap"
check_ids=""
error_code=""
recovery_action=""
status="running"
services_json='{}'

append_check() {
  if [[ -n "$check_ids" ]]; then check_ids+=","; fi
  check_ids+="$1"
}

recover_for_stage() {
  case "$1" in
    host_preflight)
      printf '%s' 'Resolve failed host checks, including Docker Engine access, registry access, disk capacity, and imports of the configured licensed OpenEdge/JDK images, then rerun bootstrap.'
      ;;
    input_preflight|openedge_generic|openedge_final)
      printf '%s' 'Correct the named local OpenEdge input, seed database or imported image check and rerun bootstrap; PARKBENCH_OPENEDGE_DEFAULT_SEED must name a Linux OpenEdge database folder under PARKBENCH_DISCOVERY_SEEDS_ROOT, and licensed files and credentials stay outside Git.'
      ;;
    catalog_inputs)
      printf '%s' 'Restore the generated application archive and writable host data root, then rerun bootstrap.'
      ;;
    dependency_install)
      printf '%s' 'Restore npm registry access and rerun npm ci from the ParkBench repository root.'
      ;;
    application_build)
      printf '%s' 'Review the retained redacted build output, correct the application build issue, and rerun bootstrap.'
      ;;
    support_images|platform_start)
      printf '%s' 'Review the retained redacted Compose output and correct the reported image-build or service-startup error. If the Docker Engine is unavailable, restore access to the Engine selected by the Docker CLI, then rerun bootstrap.'
      ;;
    service_readiness)
      printf '%s' 'Inspect the required service health and retained redacted startup output, correct the unavailable service, and rerun bootstrap.'
      ;;
    *)
      printf '%s' 'Review the retained redacted bootstrap log, correct the failed setup condition, and rerun bootstrap.'
      ;;
  esac
}

infer_error_code() {
  local value
  value="$(sed -nE 's/.*"error"[[:space:]]*:[[:space:]]*"([a-z][a-z0-9_:-]{0,100})".*/\1/p' "$diagnostic_log" | tail -n 1)"
  if [[ "$value" =~ ^[a-z][a-z0-9_:-]{0,100}$ ]]; then
    printf '%s' "$value"
    return
  fi
  case "$stage" in
    host_preflight) printf '%s' 'host_preflight_failed' ;;
    input_preflight) printf '%s' 'openedge_preflight_failed' ;;
    dependency_install) printf '%s' 'dependency_install_failed' ;;
    application_build) printf '%s' 'application_build_failed' ;;
    openedge_generic) printf '%s' 'openedge_generic_build_failed' ;;
    openedge_final) printf '%s' 'openedge_final_build_failed' ;;
    catalog_inputs) printf '%s' 'catalog_input_staging_failed' ;;
    support_images) printf '%s' 'support_image_build_failed' ;;
    platform_start) printf '%s' 'platform_start_failed' ;;
    service_readiness) printf '%s' 'required_services_not_ready' ;;
    *) printf '%s' 'bootstrap_failed' ;;
  esac
}

finalize() {
  local exit_status=$?
  trap - EXIT
  if ((exit_status != 0)); then
    status="failed"
    error_code="${error_code:-$(infer_error_code)}"
    recovery_action="${recovery_action:-$(recover_for_stage "$stage")}"
  elif [[ "$status" != "ready" ]]; then
    status="failed"
    error_code="bootstrap_incomplete"
    recovery_action="$(recover_for_stage "$stage")"
    exit_status=1
  fi

  local report
  report="$(
    PARKBENCH_BOOTSTRAP_STARTED_AT="$started_at" \
      PARKBENCH_BOOTSTRAP_STATUS="$status" \
      PARKBENCH_BOOTSTRAP_STAGE="$stage" \
      PARKBENCH_BOOTSTRAP_COMPONENT="$component" \
      PARKBENCH_BOOTSTRAP_VALID="$([[ "$status" == "ready" ]] && printf true || printf false)" \
      PARKBENCH_BOOTSTRAP_ERROR="$error_code" \
      PARKBENCH_BOOTSTRAP_CHECKS="$check_ids" \
      PARKBENCH_BOOTSTRAP_SERVICES="$services_json" \
      PARKBENCH_BOOTSTRAP_DIAGNOSTIC_LOG="bootstrap/attempt-$attempt_id.log" \
      PARKBENCH_BOOTSTRAP_RECOVERY_ACTION="$recovery_action" \
      PARKBENCH_HOST_DATA_ROOT="$data_root" \
      node "$SCRIPT_DIR/bootstrap-readiness.mjs" --report
  )" || {
    printf '{"valid":false,"error":"bootstrap_report_failed"}\n' >&2
    exit 1
  }
  printf '%s\n' "$report"
  exit "$exit_status"
}
trap finalize EXIT

run_stage() {
  stage="$1"
  component="$2"
  shift 2
  append_check "${stage//-/_}"
  printf '[bootstrap] stage=%s component=%s\n' "$stage" "$component" >> "$diagnostic_log"
  local command_status
  # On WSL drvfs the shell's working-directory handle can go stale after a stage that creates
  # and removes many directories (image builds); re-enter the repository root by path.
  cd "$ROOT_DIR" || return 1
  set +e
  "$@" 2>&1 | node "$SCRIPT_DIR/redact-diagnostics.mjs" | tee -a "$diagnostic_log"
  command_status=${PIPESTATUS[0]}
  set -e
  if ((command_status != 0)); then
    error_code="$(infer_error_code)"
    recovery_action="$(recover_for_stage "$stage")"
    return "$command_status"
  fi
}

load_generated_environment() {
  local file="$1"
  local environment_exports
  environment_exports="$(node "$SCRIPT_DIR/lib/load-env.cjs" -- --root "$ROOT_DIR" --env-file "$file" --required --prefer-file --shell)" ||
    return 1
  eval "$environment_exports"
  export PARKBENCH_ENV_FILE="$ACTIVE_ENV_FILE"
}

run_stage host_preflight host-environment node "$SCRIPT_DIR/host-preflight.mjs"
run_stage input_preflight openedge-inputs npm run openedge:preflight -- --image-stage all
run_stage dependency_install npm-dependencies npm ci
run_stage application_build parkbench-application "$SCRIPT_DIR/build.sh"
run_stage openedge_generic generic-openedge-images npm run openedge:build -- --image-stage generic
run_stage openedge_final final-openedge-image npm run openedge:build -- --image-stage final

openedge_root="${PARKBENCH_OPENEDGE_OUTPUT_ROOT:-.parkbench/openedge}"
if ! openedge_root="$(node "$SCRIPT_DIR/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$openedge_root" 2>/dev/null)"; then
  stage="openedge_final"
  component="final-openedge-image"
  error_code="openedge_output_path_invalid"
  recovery_action="Set PARKBENCH_OPENEDGE_OUTPUT_ROOT to an accessible repository or external output directory and rerun bootstrap."
  exit 1
fi
images_env="$openedge_root/images.env"
if [[ ! -f "$images_env" ]]; then
  stage="openedge_final"
  component="final-openedge-image"
  error_code="final_image_environment_missing"
  recovery_action="$(recover_for_stage "$stage")"
  exit 1
fi
# This is a generated ParkBench hand-off file written by the final image builder.
load_generated_environment "$images_env"

# Stage operator supplied inputs where the control plane discovers them.
run_stage catalog_inputs managed-runner-archive node "$SCRIPT_DIR/openedge/stage-catalog-inputs.mjs"

run_stage support_images support-images "$SCRIPT_DIR/build-images.sh"
run_stage platform_start local-platform "$SCRIPT_DIR/start.sh" --no-build

stage="service_readiness"
component="required-platform-services"
append_check required_services_ready
readiness_raw="$log_dir/.readiness-$attempt_id.tmp"
set +e
node "$SCRIPT_DIR/bootstrap-readiness.mjs" > "$readiness_raw" 2>&1
readiness_status=$?
set -e
chmod 600 "$readiness_raw" 2>/dev/null || true
readiness_output="$(node "$SCRIPT_DIR/redact-diagnostics.mjs" < "$readiness_raw")"
rm -f "$readiness_raw"
printf '%s\n' "$readiness_output" | tee -a "$diagnostic_log"
services_json="$(printf '%s\n' "$readiness_output" | node --input-type=module -e 'let input=""; for await (const part of process.stdin) input += part; const value = JSON.parse(input); process.stdout.write(JSON.stringify(value.services ?? {}));')"
if ((readiness_status != 0)); then
  error_code="required_services_not_ready"
  recovery_action="$(recover_for_stage "$stage")"
  exit 1
fi

stage="ready"
component="parkbench-platform"
status="ready"
exit 0
