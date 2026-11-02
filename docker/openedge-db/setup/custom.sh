#!/bin/sh
set -eu
helpers=${PARKBENCH_SETUP_HELPERS:-/usr/local/lib/parkbench/setup}
exec "$helpers/custom-supervisor" "$1/command.sh" "$2"
