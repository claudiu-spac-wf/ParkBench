#!/bin/sh
set -eu
set_directory=$1
. "$set_directory/argv.sh"
exec proutil "$@" < "$set_directory/stdin"
