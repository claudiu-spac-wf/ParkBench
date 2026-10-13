#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  printf 'Usage: scripts/status.sh [docker compose ps options]\n\nShow ParkBench service status.\n'
  exit 0
fi

compose ps "$@"
printf '\nPublished endpoints:\n'
show_published_port 'Web UI' web 80
show_published_port 'Control-plane' control-plane 3000
show_published_port 'Grafana' grafana 3000
show_published_port 'Prometheus' prometheus 9090
show_published_port 'cAdvisor UI' cadvisor 8080
