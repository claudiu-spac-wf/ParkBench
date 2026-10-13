#!/usr/bin/env bash
set -euo pipefail

COMMON_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$COMMON_DIR/../.." && pwd)"
ACTIVE_ENV_FILE="${PARKBENCH_ENV_FILE:-$ROOT_DIR/.env.local}"
if [[ "$ACTIVE_ENV_FILE" != /* ]]; then ACTIVE_ENV_FILE="$ROOT_DIR/$ACTIVE_ENV_FILE"; fi
export PARKBENCH_ENV_FILE="$ACTIVE_ENV_FILE"

cd "$ROOT_DIR"

load_local_environment() {
  require_command node
  local environment_exports
  local -a loader_options=(--root "$ROOT_DIR" --env-file "$ACTIVE_ENV_FILE" --shell)
  environment_exports="$(node "$ROOT_DIR/scripts/lib/load-env.cjs" -- "${loader_options[@]}")" ||
    return 1
  eval "$environment_exports"
  ACTIVE_ENV_FILE="$PARKBENCH_ENV_FILE"
}

require_platform_environment() {
  require_command node
  local environment_exports
  local -a loader_options=(--root "$ROOT_DIR" --env-file "$ACTIVE_ENV_FILE" --required --platform --shell)
  environment_exports="$(node "$ROOT_DIR/scripts/lib/load-env.cjs" -- "${loader_options[@]}")" ||
    return 1
  eval "$environment_exports"
}

load_openedge_generated_environment() {
  local output_root="${PARKBENCH_OPENEDGE_OUTPUT_ROOT:-.parkbench/openedge}"
  if ! output_root="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$output_root")"; then
    die "PARKBENCH_OPENEDGE_OUTPUT_ROOT is invalid"
  fi
  local generated_environment="$output_root/images.env"
  [[ -f "$generated_environment" ]] || return 0

  local compose_environment_file="$ACTIVE_ENV_FILE"
  local environment_exports
  local -a loader_options=(--root "$ROOT_DIR" --env-file "$generated_environment" --required --prefer-file --shell)
  environment_exports="$(node "$ROOT_DIR/scripts/lib/load-env.cjs" -- "${loader_options[@]}")" ||
    die "generated OpenEdge environment could not be loaded"
  eval "$environment_exports"
  ACTIVE_ENV_FILE="$compose_environment_file"
  export PARKBENCH_ENV_FILE="$ACTIVE_ENV_FILE"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

load_local_environment

retag_created_image() {
  local reference="$1"
  local named="${reference%%@*}"
  local repository="$named"
  if [[ "$named" == *:* && "${named##*/}" == *:* ]]; then repository="${named%:*}"; fi
  printf '%s:%s' "$repository" "$PARKBENCH_IMAGE_TAG"
}

if [[ -n "${PARKBENCH_IMAGE_TAG:-}" ]]; then
  for created_image_variable in PARKBENCH_LOADGEN_IMAGE PARKBENCH_OBSERVER_IMAGE; do
    if [[ -n "${!created_image_variable:-}" ]]; then
      printf -v "$created_image_variable" '%s' "$(retag_created_image "${!created_image_variable}")"
      export "$created_image_variable"
    fi
  done
fi

compose() {
  require_command docker
  local env_file="$ACTIVE_ENV_FILE"
  [[ -f "$env_file" ]] || die "environment file not found"
  local compose_file="${PARKBENCH_COMPOSE_FILE:-$ROOT_DIR/deploy/platform-compose.yml}"
  if ! compose_file="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$compose_file")"; then
    die "Compose path is invalid"
  fi
  local host_data_root="${PARKBENCH_HOST_DATA_ROOT:-.parkbench}"
  if ! host_data_root="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$host_data_root")"; then
    die "PARKBENCH_HOST_DATA_ROOT is invalid"
  fi
  local docker_host_root="${PARKBENCH_DOCKER_HOST_PATH_ROOT:-$host_data_root}"
  if ! docker_host_root="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$docker_host_root")"; then
    die "PARKBENCH_DOCKER_HOST_PATH_ROOT is invalid"
  fi
  local prometheus_target_dir="${PARKBENCH_PROMETHEUS_TARGET_DIR:-.parkbench/prometheus-targets}"
  if ! prometheus_target_dir="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$prometheus_target_dir")"; then
    die "PARKBENCH_PROMETHEUS_TARGET_DIR is invalid"
  fi
  local prometheus_data_root="${PARKBENCH_PROMETHEUS_DATA_ROOT:-.parkbench/prometheus_data}"
  if ! prometheus_data_root="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$prometheus_data_root")"; then
    die "PARKBENCH_PROMETHEUS_DATA_ROOT is invalid"
  fi
  local docker_socket_path="${PARKBENCH_DOCKER_SOCKET_PATH:-/var/run/docker.sock}"
  if ! docker_socket_path="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$docker_socket_path")"; then
    die "PARKBENCH_DOCKER_SOCKET_PATH is invalid"
  fi
  export PARKBENCH_ENV_FILE="$env_file"
  export PARKBENCH_COMPOSE_FILE="$compose_file"
  export PARKBENCH_HOST_DATA_ROOT="$host_data_root"
  export PARKBENCH_DOCKER_HOST_PATH_ROOT="$docker_host_root"
  export PARKBENCH_PROMETHEUS_TARGET_DIR="$prometheus_target_dir"
  export PARKBENCH_PROMETHEUS_DATA_ROOT="$prometheus_data_root"
  export PARKBENCH_DOCKER_SOCKET_PATH="$docker_socket_path"
  export PARKBENCH_REPOSITORY_ROOT="$ROOT_DIR"
  for kind in SCENARIOS WORKLOADS OBSERVERS SEEDS ARCHIVES; do
    local setting="PARKBENCH_DISCOVERY_${kind}_ROOT"
    local default_root
    case "$kind" in
      SCENARIOS) default_root="examples/scenarios" ;;
      WORKLOADS) default_root="openedge/workloads/Workloads" ;;
      OBSERVERS) default_root=".parkbench/observers" ;;
      SEEDS) default_root=".parkbench/seeds" ;;
      ARCHIVES) default_root=".parkbench/archives" ;;
    esac
    local source_root="${!setting:-$default_root}"
    if ! source_root="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" -- "$source_root")"; then
      die "$setting is invalid"
    fi
    export "PARKBENCH_HOST_DISCOVERY_${kind}_ROOT=$source_root"
  done
  for setting in PARKBENCH_OPENEDGE_APP_ARCHIVE PARKBENCH_OPENEDGE_IMAGE_MANIFEST; do
    local configured_path="${!setting:-}"
    if [[ -n "$configured_path" ]]; then
      local control_plane_path
      if ! control_plane_path="$(node "$ROOT_DIR/scripts/lib/resolve-paths.cjs" --root "$ROOT_DIR" --allowed-root "$docker_host_root" --map-to-container /var/lib/parkbench -- "$configured_path")"; then
        die "$setting must resolve inside PARKBENCH_DOCKER_HOST_PATH_ROOT for Compose use"
      fi
      export "PARKBENCH_CONTROL_PLANE_${setting#PARKBENCH_}=$control_plane_path"
    fi
  done
  if [[ "${DOCKER_TARGET_VERIFIED:-0}" != 1 ]]; then
    node "$ROOT_DIR/scripts/lib/docker-target.cjs" --verify || return 1
    DOCKER_TARGET_VERIFIED=1
  fi
  [[ -f "$compose_file" ]] || die "Compose file not found"
  docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

compose_port() {
  local service="$1"
  local container_port="$2"
  compose port "$service" "$container_port" 2>/dev/null || true
}

require_published_port() {
  local service="$1"
  local container_port="$2"
  local endpoint
  endpoint="$(compose_port "$service" "$container_port")"
  endpoint="${endpoint%%$'\n'*}"
  [[ -n "$endpoint" ]] || die "service $service has no published host port for container port $container_port"
  printf '%s' "$endpoint"
}

show_published_port() {
  local label="$1"
  local service="$2"
  local container_port="$3"
  local endpoint
  endpoint="$(compose_port "$service" "$container_port")"
  endpoint="${endpoint%%$'\n'*}"
  if [[ -n "$endpoint" ]]; then
    printf '  %-16s http://%s\n' "$label:" "$endpoint"
  else
    printf '  %-16s not published (service is not running)\n' "$label:"
  fi
}

usage_header() {
  printf 'ParkBench repository: %s\n' "$ROOT_DIR"
}
