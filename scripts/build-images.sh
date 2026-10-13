#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  printf 'Usage: scripts/build-images.sh [docker compose build options]\n\nCompile TypeScript and build the pinned loadgen and observer support images.\n'
  exit 0
fi

require_platform_environment
require_command npm
npm run build
compose --profile build build loadgen-image observer-image "$@"
