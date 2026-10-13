#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  printf 'Usage: scripts/check.sh\n\nRun typecheck, lint, formatting, security, and the complete test suite.\n'
  exit 0
fi

require_command npm
npm run typecheck
npm run lint
npm run format:check
npm run test:security
npm test
