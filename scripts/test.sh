#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage_header
  cat <<'USAGE'
Usage: scripts/test.sh [suite] [options]

Suites:
  all          Run the complete non-live test suite (default).
  contract     Run contract tests.
  unit         Run unit tests.
  integration  Run integration tests.
  security     Run security tests.
  ui           Run Node-based UI tests.
  browser      Run Playwright browser tests.
  licensed-browser  Run fail-closed licensed ParkBench browser acceptance.
  feature      Run the focused Web UI usability Playwright suite.
USAGE
  exit 0
fi

require_command npm
suite="${1:-all}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$suite" in
  all) exec npm test "$@" ;;
  contract) exec npm run test:contract -- "$@" ;;
  unit) exec npm run test:unit -- "$@" ;;
  integration) exec npm run test:integration -- "$@" ;;
  security) exec npm run test:security -- "$@" ;;
  ui) exec npm run test:ui -- "$@" ;;
  browser) exec npm run test:browser -- "$@" ;;
  licensed-browser) exec npm run test:browser:licensed -- "$@" ;;
  feature) exec npm run test:browser -- tests/browser/web-ui-usability.spec.ts "$@" ;;
  *)
    printf 'Unknown test suite: %s\n' "$suite" >&2
    exit 2
    ;;
esac
