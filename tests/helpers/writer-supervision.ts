import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
export function writerHarness(changes: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-writer-lifecycle-"));
  const bin = path.join(root, "bin"),
    db = path.join(root, "controls");
  fs.mkdirSync(bin);
  fs.mkdirSync(db);
  const scripts: Record<string, string> = {
    mpro: `for arg do prefix=$arg; done
echo native >> "$TRACE"
a=$(wc -l < "$LEDGER_APW"); b=$(wc -l < "$LEDGER_BIW")
if [ -f .parkbench-controls-ready ] && [ "\${LOSE:-0}" = 1 ]; then a=0; fi
apids=; bpids=; i=0
while [ "$i" -lt "$a" ]; do i=$((i+1)); apids=\${apids:+$apids,}$((100+i)); done
if [ "$b" -gt 0 ]; then bpids=201; fi
printf 'clusterKiB=16384\nbiBuffers=%s\ncapacity=%s\napwCount=%s\nbiwCount=%s\napwPids=%s\nbiwPids=%s\n' "\${BUFFERS:-64}" "\${CAPACITY:-21}" "$a" "$b" "$apids" "$bpids" > "$prefix.env"
writers='[]'; separator=; old_ifs=$IFS; IFS=,
for pid in $apids; do writers="\${writers%]}\${separator}{\\"type\\":\\"APW\\",\\"pid\\":$pid}]"; separator=,; done
for pid in $bpids; do writers="\${writers%]}\${separator}{\\"type\\":\\"BIW\\",\\"pid\\":$pid}]"; separator=,; done
IFS=$old_ifs
printf '{"contractVersion":"db-startup-state.v1","capturedAt":"2026-10-03T00:00:00Z","nativeClusterKiB":16384,"biBuffers":%s,"connectionCapacity":%s,"apwCount":%s,"biwCount":%s,"writers":%s}' "\${BUFFERS:-64}" "\${CAPACITY:-21}" "$a" "$b" "$writers" > "$prefix.json"`,
    proapw: 'echo apw >> "$TRACE"; echo apw >> "$LEDGER_APW"; exit "${WRITER_EXIT:-0}"',
    probiw: 'echo biw >> "$TRACE"; echo biw >> "$LEDGER_BIW"',
    ps: 'pid=$2; kind=apw; [ "$pid" -ne 201 ] || kind=biw; [ "${WRONG_MEMBER:-0}" != 1 ] || kind=other; echo "/psc/dlc/bin/_mprshut $OWNED_DB -C $kind"',
    awk: 'case "$*" in */proc/*/stat*) if [ "${REPLACE_PID:-0}" = 1 ] && [ -f .parkbench-controls-ready ]; then echo 54321; else echo 12345; fi ;; *) exec /usr/bin/awk "$@" ;; esac',
    sleep: "exec /bin/sleep 0.02"
  };
  for (const [name, script] of Object.entries(scripts))
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nset -eu\n" + script + "\n", { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    TRACE: path.join(root, "trace"),
    LEDGER_APW: path.join(root, "apws"),
    LEDGER_BIW: path.join(root, "biws"),
    OWNED_DB: path.join(db, "controls"),
    PARKBENCH_APW_COUNT: "2",
    PARKBENCH_BIW_ENABLED: "true",
    PARKBENCH_BI_CLUSTER_KIB: "16384",
    PARKBENCH_EXPECTED_BI_BUFFERS: "64",
    ...changes
  };
  fs.writeFileSync(env.LEDGER_APW, "");
  fs.writeFileSync(env.LEDGER_BIW, "");
  const args = [path.resolve("docker/openedge-db/controls-lifecycle.sh"), db, "controls"];
  return {
    root,
    db,
    env,
    args,
    run: () => spawnSync("sh", args, { env, encoding: "utf8", timeout: 5000 }),
    close: () => fs.rmSync(root, { recursive: true, force: true })
  };
}
