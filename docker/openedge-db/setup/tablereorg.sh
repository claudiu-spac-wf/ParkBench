#!/bin/sh
# A single set; run-setup owns the surrounding one-broker-per-step lifetime.
set -eu
set_directory=$1
. "$set_directory/argv.sh"
exec proutil "$@" < "$set_directory/stdin"
