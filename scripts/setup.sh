#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  printf 'Usage: scripts/setup.sh\n\nInstall pinned npm dependencies and create .env.local when absent.\n'
  exit 0
fi

require_command npm
npm ci

if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  printf 'Created .env.local from .env.example; edit its local image and path settings before starting.\n'
else
  printf '.env.local already exists; leaving it unchanged.\n'
fi
