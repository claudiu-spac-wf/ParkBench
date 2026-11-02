import {
  DatabaseIopsOwner,
  DatabaseIopsCoverage,
  DatabaseIopsDevice,
  DatabaseIopsError,
  DATABASE_IOPS_LIMITS,
  validateDatabaseIopsCoverage
} from "../../contracts/src/database-iops";
import { EngineApi } from "./engine-api";
import { IopsSnapshot } from "./database-iops";
import { IopsReadonlySession, openIopsReadonlySession } from "./iops-readonly-session";
/** Fixed, read-only host program. All variable values are positional arguments, never shell code. */
export const IOPS_PROBE_SCRIPT = String.raw`
set -eu
pid=$1
owner=$2
root=$3
capture=policy
if test "$#" -gt 3; then capture=$4; fi
read_owned() {
 base=$1
 test -r "$base/cgroup.procs" && test -r "$base/io.max" || return 1
 test "$(stat -f -c %t "$base" 2>/dev/null)" = 63677270 || return 1
 found=false
 while IFS= read -r task; do if test "$task" = "$pid"; then found=true; break; fi; done < "$base/cgroup.procs"
 test "$found" = true || return 1
 printf 'OWNER\t%s\t%s\n' "$pid" "$owner"
 while IFS= read -r line; do printf 'MAX\t%s\n' "$line"; done < "$base/io.max"
 if test "$capture" = validation; then
  while IFS= read -r line; do printf 'STAT\t%s\n' "$line"; done < "$base/io.stat"
 fi
}
confirmed=false
for base in "/proc/1/root/sys/fs/cgroup/docker/$owner" "/proc/1/root/sys/fs/cgroup/system.slice/docker-$owner.scope" "/proc/1/root/sys/fs/cgroup/$owner"; do
 if read_owned "$base"; then confirmed=true; break; fi
done
if test "$confirmed" != true; then
 cg=""; read -r cg < "/proc/$pid/cgroup"
 case "$cg" in *"$owner"*) if read_owned "/proc/$pid/root/sys/fs/cgroup"; then confirmed=true; fi;; esac
fi
test "$confirmed" = true || exit 25
while IFS= read -r line; do
 set -- $line
 point=$5
 use=false
 case "$root/" in "$point/"*) use=true;; esac
 case "$point/" in "$root/"*) use=true;; esac
 if test "$use" = true; then
  printf 'MOUNT\t%s\n' "$line"
  dev=$3
  if test -r "/proc/1/root/sys/dev/block/$dev/uevent"; then
   test ! -r "/proc/1/root/sys/dev/block/$dev/partition" || exit 29
   for slave in /proc/1/root/sys/dev/block/"$dev"/slaves/*; do test ! -e "$slave" || exit 29; done
   name=""; generation=""
   while IFS='=' read -r key value; do case "$key" in DEVNAME) name=$value;; DISKSEQ) generation=$value;; esac; done < "/proc/1/root/sys/dev/block/$dev/uevent"
   test -n "$name" && test -b "/proc/1/root/dev/$name" || exit 26
   block=$(stat -c '%t:%T' "/proc/1/root/dev/$name")
   printf 'DEVICE\t%s\t/dev/%s\t%s\t%s\n' "$dev" "$name" "$block" "$generation"
  fi
 fi
done < "/proc/$pid/mountinfo"
`;
const SYMLINK_PROBE = String.raw`
set -eu
root=$1
test "$(readlink -f "$root")" = "$root"
find "$root" -type l -exec sh -c '
 root=$1; shift
 for entry do
  target=$(readlink -f "$entry") || exit 28
  case "$target" in "$root"|"$root"/*) ;; *) exit 28;; esac
 done
' sh "$root" {} +
`;
const decodeMount = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
export function parseIopsProbe(
  text: string,
  owner: DatabaseIopsOwner,
  workingRoot: string
): Pick<IopsSnapshot, "coverage" | "kernel"> {
  if (Buffer.byteLength(text) > DATABASE_IOPS_LIMITS.replyBytes)
    throw new DatabaseIopsError("database_iops_device_unresolved", undefined, "probe_capacity");
  const rows = text.trim().split("\n");
  if (!rows.includes(`OWNER\t${owner.pid}\t${owner.containerId}`))
    throw new DatabaseIopsError("database_iops_unconfirmed", undefined, "cgroup_owner_unconfirmed");
  const kernel: IopsSnapshot["kernel"] = {};
  const nodes = new Map<string, { path: string; generation?: string }>();
  const mounts: Array<{ id: string; device: string; point: string; filesystem: string }> = [];
  for (const row of rows) {
    const [tag, ...parts] = row.split("\t");
    if (tag === "MAX") {
      const [device, ...limits] = parts.join("\t").split(/\s+/);
      if (!/^\d+:\d+$/.test(device))
        throw new DatabaseIopsError(
          "database_iops_unconfirmed",
          undefined,
          "kernel_policy_invalid"
        );
      const fields = Object.fromEntries(limits.map((v) => v.split("=")));
      const rate = (v: string) =>
        v === undefined || v === "max"
          ? ("max" as const)
          : /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0
            ? Number(v)
            : undefined;
      const riops = rate(fields.riops),
        wiops = rate(fields.wiops);
      if (riops === undefined || wiops === undefined)
        throw new DatabaseIopsError(
          "database_iops_unconfirmed",
          undefined,
          "kernel_policy_invalid"
        );
      kernel[device] = { riops, wiops };
    } else if (tag === "DEVICE") {
      const [device, path, hex, generation] = parts;
      const pair = hex?.split(":").map((n) => parseInt(n, 16));
      if (!pair || pair.length !== 2 || pair.join(":") !== device)
        throw new DatabaseIopsError(
          "database_iops_device_unresolved",
          undefined,
          "block_node_mismatch"
        );
      nodes.set(device, { path, ...(generation ? { generation } : {}) });
    } else if (tag === "MOUNT") {
      const line = parts.join("\t"),
        split = line.split(" - "),
        head = split[0].split(" "),
        tail = split[1]?.split(" ");
      if (!tail || head.length < 6)
        throw new DatabaseIopsError("database_iops_device_unresolved", undefined, "mount_invalid");
      mounts.push({
        id: head[0],
        device: head[2],
        point: decodeMount(head[4]),
        filesystem: tail[0]
      });
    }
  }
  const base = mounts
    .filter((m) => workingRoot === m.point || workingRoot.startsWith(m.point + "/"))
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (!base)
    throw new DatabaseIopsError(
      "database_iops_device_unresolved",
      undefined,
      "working_mount_missing"
    );
  const selected = [base, ...mounts.filter((m) => m.point.startsWith(workingRoot + "/"))];
  const devices = new Map<string, DatabaseIopsDevice>();
  for (const m of selected) {
    const node = nodes.get(m.device);
    if (
      !node ||
      !["ext4", "xfs", "btrfs", "f2fs"].includes(m.filesystem) ||
      m.device.startsWith("0:")
    )
      throw new DatabaseIopsError(
        "database_iops_unsupported",
        undefined,
        "working_backing_or_writeback_unsupported"
      );
    const d = devices.get(m.device) ?? {
      id: m.device,
      path: node.path,
      generation: node.generation,
      filesystem: m.filesystem,
      mountId: m.id,
      paths: []
    };
    const p = m === base ? workingRoot : m.point;
    if (!d.paths.includes(p)) d.paths.push(p);
    d.mountId = [...new Set([...d.mountId.split("|"), m.id])].sort().join("|");
    devices.set(m.device, d);
  }
  const coverage = validateDatabaseIopsCoverage({
    owner,
    workingRoot,
    devices: [...devices.values()].sort((a, b) => a.id.localeCompare(b.id))
  });
  return { coverage, kernel };
}
export class DatabaseIopsInspector {
  private readerId?: string;
  private worker?: IopsReadonlySession;
  private workerOwner?: DatabaseIopsOwner;
  get runtimeWorkerId() {
    return this.worker?.execId;
  }
  close() {
    this.worker?.close();
    this.worker = undefined;
    this.workerOwner = undefined;
  }
  async prepareRuntime(owner: DatabaseIopsOwner, workingRoot: string, deadline: number) {
    if (!this.readerId)
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "verified_host_reader_required"
      );
    const program = `while IFS= read -r -t 300 token; do
case "$token" in ""|*[!0-9]*) exit 30;; esac
(
${IOPS_PROBE_SCRIPT}
)
status=$?
printf '\\nIOPS_END\\t%s\\t%s\\n' "$token" "$status"
done
`;
    this.worker = await openIopsReadonlySession(
      this.api,
      this.readerId,
      [
        "sh",
        "-c",
        program,
        "iops-runtime-worker",
        String(owner.pid),
        owner.containerId,
        workingRoot
      ],
      deadline
    );
    this.workerOwner = structuredClone(owner);
  }
  constructor(
    readonly api: EngineApi,
    readonly docker = "docker"
  ) {}
  private async command(args: string[], deadline: number) {
    // Both startup containment and runtime kernel inspection remain fixed read-only programs.
    if (args[0] !== "exec")
      throw new DatabaseIopsError("database_iops_unconfirmed", undefined, "readonly_exec_required");
    return this.api.execReadonly(args[1], args.slice(2), deadline);
  }
  async selectDatabase(projectName: string, runId: string, deadline: number) {
    const list = await this.api.request(
      "GET",
      this.api.versioned(
        `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${projectName}`, "com.docker.compose.service=database", `parkbench.run_id=${runId}`] }))}`
      ),
      undefined,
      deadline
    );
    if (!Array.isArray(list) || list.length !== 1)
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "unique_owned_database_required"
      );
    return list[0].Id as string;
  }
  async snapshot(
    id: string,
    projectName: string,
    runId: string,
    databaseName: string,
    deadline: number,
    startup = false
  ): Promise<IopsSnapshot> {
    if (!startup && !this.worker)
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "readonly_worker_not_prepared"
      );
    const [data, info, runtimeText] = await Promise.all([
      this.api.inspect(id, deadline),
      this.api.request("GET", this.api.versioned("/info"), undefined, deadline),
      startup ? Promise.resolve(undefined) : this.worker.request(deadline)
    ]);
    if (info.ID !== this.api.daemonId)
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "daemon_identity_changed"
      );
    const labels = data.Config?.Labels ?? {};
    if (
      data.Id !== id ||
      labels["parkbench.managed"] !== "true" ||
      labels["parkbench.run_id"] !== runId ||
      labels["parkbench.component"] !== "database" ||
      labels["com.docker.compose.project"] !== projectName ||
      !data.State?.Running ||
      !Number.isSafeInteger(data.State.Pid) ||
      data.State.Pid <= 0
    )
      throw new DatabaseIopsError(
        "database_iops_policy_conflict",
        undefined,
        "database_owner_or_state_mismatch"
      );
    if (!/^[a-zA-Z0-9_-]+$/.test(databaseName))
      throw new DatabaseIopsError(
        "database_iops_device_unresolved",
        undefined,
        "working_name_invalid"
      );
    const workingRoot = `/psc/wrk/${databaseName}`;
    const mount = data.Mounts?.find((m) => m.Destination === "/psc/wrk");
    if (!mount || mount.Type !== "volume" || !mount.RW || !mount.Name || !mount.Source)
      throw new DatabaseIopsError(
        "database_iops_device_unresolved",
        undefined,
        "owned_working_volume_required"
      );
    const vol = await (startup
      ? this.api.request(
          "GET",
          this.api.versioned(`/volumes/${encodeURIComponent(mount.Name)}`),
          undefined,
          deadline
        )
      : Promise.resolve(undefined));
    if (
      vol &&
      (vol.Labels?.["parkbench.managed"] !== "true" ||
        vol.Labels?.["parkbench.run_id"] !== runId ||
        vol.Driver !== "local" ||
        vol.Mountpoint !== mount.Source)
    )
      throw new DatabaseIopsError(
        "database_iops_policy_conflict",
        undefined,
        "working_volume_owner_mismatch"
      );
    const owner: DatabaseIopsOwner = {
      daemonId: this.api.daemonId,
      containerId: id,
      pid: data.State.Pid,
      startedAt: data.State.StartedAt,
      runId,
      composeProject: projectName,
      component: "database"
    };
    if (!this.readerId) {
      const list = await this.api.request(
        "GET",
        this.api.versioned(
          `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ["com.docker.compose.project=parkbench-platform", "com.docker.compose.service=cadvisor"] }))}`
        ),
        undefined,
        deadline
      );
      if (!Array.isArray(list) || list.length !== 1)
        throw new DatabaseIopsError(
          "database_iops_unsupported",
          undefined,
          "host_reader_unavailable"
        );
      const reader = await this.api.inspect(list[0].Id, deadline);
      if (reader.HostConfig?.PidMode !== "host" || !reader.State?.Running)
        throw new DatabaseIopsError(
          "database_iops_unsupported",
          undefined,
          "host_reader_namespace_unavailable"
        );
      this.readerId = reader.Id;
    }
    if (!startup && JSON.stringify(owner) !== JSON.stringify(this.workerOwner))
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "readonly_worker_owner_changed"
      );
    if (startup)
      await this.command(
        ["exec", id, "sh", "-c", SYMLINK_PROBE, "iops-path-check", workingRoot],
        deadline
      );
    const text = startup
      ? await this.command(
          [
            "exec",
            this.readerId,
            "sh",
            "-c",
            IOPS_PROBE_SCRIPT,
            "iops-host-check",
            String(owner.pid),
            owner.containerId,
            workingRoot
          ],
          deadline
        )
      : runtimeText;
    const observed = parseIopsProbe(text, owner, workingRoot);
    const rules = {
      read: data.HostConfig.BlkioDeviceReadIOps ?? [],
      write: data.HostConfig.BlkioDeviceWriteIOps ?? []
    };
    return {
      ...observed,
      rules,
      capability: {
        engineVersion: this.api.engineVersion,
        apiVersion: this.api.apiVersion,
        cgroupVersion: "2",
        filesystem: [...new Set(observed.coverage.devices.map((d) => d.filesystem))].join(",")
      }
    };
  }
}
