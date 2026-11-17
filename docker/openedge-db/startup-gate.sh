#!/bin/sh
# Finite-policy startup barrier. The controller's durable intent/verification precedes release.
set -eu
gate=${PARKBENCH_IOPS_GATE_DIR:?}
run=${PARKBENCH_RUN_ID:?}
revision=${PARKBENCH_EXECUTION_REVISION:?}
nonce=${PARKBENCH_IOPS_GATE_NONCE:?}
case "$run:$revision:$nonce" in *[!a-zA-Z0-9_.:-]*) echo database_iops_apply_failed:gate_identity >&2; exit 56 ;; esac
case "${PARKBENCH_IOPS_GATE_TIMEOUT_SECONDS:-300}" in ''|*[!0-9]*) exit 56 ;; esac
timeout=${PARKBENCH_IOPS_GATE_TIMEOUT_SECONDS:-300}
[ "$timeout" -ge 1 ] && [ "$timeout" -le 86400 ] || exit 56
[ -d "$gate" ] && [ "$(readlink -f "$gate")" = "$gate" ] || { echo database_iops_apply_failed:gate_path >&2; exit 56; }
[ ! -e "$gate/held" ] && [ ! -e "$gate/consumed" ] || { echo database_iops_apply_failed:gate_reused >&2; exit 56; }
binding="$run:$revision:$nonce"
deadline=$((${PARKBENCH_IOPS_GATE_STARTED_AT:-$(date +%s)} + timeout))
printf '%s\n' "$binding" > "$gate/held.tmp"
sync "$gate/held.tmp"
mv "$gate/held.tmp" "$gate/held"
sync "$gate"
while :; do
 [ ! -e "$gate/cancel" ] || { echo run_cancelled >&2; exit 56; }
 [ "$(date +%s)" -lt "$deadline" ] || { echo database_iops_apply_failed:startup_gate_deadline >&2; exit 56; }
 if [ -f "$gate/release" ] && [ ! -L "$gate/release" ] && [ "$(wc -c < "$gate/release")" -le 1024 ] && [ "$(cat "$gate/release")" = "$binding" ]; then
  mv "$gate/release" "$gate/consumed"
  sync "$gate/consumed"
  sync "$gate"
  exit 0
 fi
 sleep 0.1
done
