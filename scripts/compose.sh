#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

if [[ $# -eq 0 ]]; then
  printf 'Usage: scripts/compose.sh [docker compose arguments...]\n' >&2
  exit 2
fi

# Match start.sh: partial redeploys must retain the native image handoff.
load_openedge_generated_environment
compose "$@"
