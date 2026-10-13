#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

run_build=1
build_support_images=0
compose_args=()

while (($#)); do
  case "$1" in
    -h|--help)
      usage_header
      cat <<'USAGE'
Usage: scripts/start.sh [options] [docker compose up options/services]

Build the application, build the platform images, and start ParkBench detached.

Options:
  --no-build          Skip the local TypeScript/web build.
  --build-images      Build the loadgen and observer support images first.
  -h, --help          Show this help.
USAGE
      exit 0
      ;;
    --no-build)
      run_build=0
      shift
      ;;
    --build-images)
      build_support_images=1
      shift
      ;;
    --)
      shift
      compose_args+=("$@")
      break
      ;;
    *)
      compose_args+=("$1")
      shift
      ;;
  esac
done

require_platform_environment

if ((run_build)); then
  "$SCRIPT_DIR/build.sh"
fi
if ((build_support_images)); then
  "$SCRIPT_DIR/build-images.sh"
fi

load_openedge_generated_environment
compose up --build -d "${compose_args[@]}"
web_endpoint="$(require_published_port web 80)"
control_endpoint="$(require_published_port control-plane 3000)"
grafana_endpoint="$(require_published_port grafana 3000)"
prometheus_endpoint="$(require_published_port prometheus 9090)"
cadvisor_endpoint="$(require_published_port cadvisor 8080)"
printf 'ParkBench is starting. Published endpoints:\n'
printf '  Web UI:          http://%s\n' "$web_endpoint"
printf '  Control-plane:   http://%s\n' "$control_endpoint"
printf '  Grafana:         http://%s\n' "$grafana_endpoint"
printf '  Prometheus:      http://%s\n' "$prometheus_endpoint"
printf '  cAdvisor UI:     http://%s\n' "$cadvisor_endpoint"
