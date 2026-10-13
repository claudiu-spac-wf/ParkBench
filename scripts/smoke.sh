#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  printf 'Usage: scripts/smoke.sh [fake|openedge] [command options]\n\nRun the fake smoke test by default, or the gated OpenEdge smoke test.\n'
  exit 0
fi

require_command npm
mode="${1:-fake}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$mode" in
  fake) exec npm run smoke:fake -- "$@" ;;
  openedge)
    require_platform_environment
    exec npm run smoke:openedge -- "$@"
    ;;
  *)
    printf 'Unknown smoke mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac
