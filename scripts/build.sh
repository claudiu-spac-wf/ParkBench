#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  printf 'Usage: scripts/build.sh\n\nBuild the control-plane TypeScript and production web UI.\n'
  exit 0
fi

require_command npm
npm run build
npm run build:web
