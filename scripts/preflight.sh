#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  printf 'Usage: scripts/preflight.sh [preflight options]\n\nRun ParkBench prerequisite validation.\n'
  exit 0
fi

require_platform_environment
require_command npm
exec npm run preflight -- "$@"
