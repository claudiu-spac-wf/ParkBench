import { RunTimeline } from "../../../../apps/control-plane/src/grafana/run-timeline";

/** Fixture scenario for the v2 dashboard integration tests (tasks T030, T036, T047). */
export const STEP_S = 5;
const HOUR_S = 3600;

export interface Fixture {
  openMetrics: string;
  timelines: Record<string, RunTimeline>;
  base: number;
  runA: { start: number; mStart: number; mEnd: number; end: number };
  runB: { start: number; mStart: number; mEnd: number; end: number };
}

type Labels = Record<string, string>;

class Builder {
  private families = new Map<string, string[]>();
  series(
    name: string,
    labels: Labels,
    from: number,
    to: number,
    value: (t: number) => number | undefined
  ) {
    const lines = this.families.get(name) ?? [];
    const labelText = Object.entries(labels)
      .map(([key, v]) => `${key}="${v}"`)
      .join(",");
    for (let t = from; t <= to; t += STEP_S) {
      const v = value(t);
      if (v === undefined) continue;
      lines.push(`${name}{${labelText}} ${v} ${t}`);
    }
    this.families.set(name, lines);
  }
  text() {
    return `${[...this.families.values()].flat().join("\n")}\n# EOF\n`;
  }
}

/** A counter increasing at `rate` per second from `from`, constant outside [from, to]. */
const counter = (rate: number, from: number, to: number) => (t: number) =>
  Math.max(0, Math.min(t, to) - from) * rate;

export function buildFixture(now = Math.floor(Date.now() / 1000)): Fixture {
  const base = Math.floor((now - 3 * HOUR_S) / 60) * 60;
  const run = (start: number) => ({
    start,
    mStart: start + 60,
    mEnd: start + 360,
    end: start + 420
  });
  const runA = run(base + 300);
  const runB = run(base + HOUR_S);
  const end = base + 2 * HOUR_S;
  const b = new Builder();

  // Host (ambient job) plus a run-tagged duplicate that must never be counted.
  for (const job of ["node-exporter", "parkbench-runs"]) {
    const extra: Labels = job === "parkbench-runs" ? { run_id: "run_a", phase: "measurement" } : {};
    for (const cpu of ["0", "1", "2", "3"]) {
      const busy = 0.1 * (Number(cpu) + 1);
      const gap = (t: number) => (t > base + 1800 && t < base + 1920 ? undefined : 1);
      b.series("node_cpu_seconds_total", { job, cpu, mode: "idle", ...extra }, base, end, (t) =>
        gap(t) ? t - base - busy * (t - base) : undefined
      );
      b.series(
        "node_cpu_seconds_total",
        { job, cpu, mode: "user", ...extra },
        base,
        end,
        (t) => busy * (t - base)
      );
    }
    for (const device of ["sda", "nvme0n1", "loop0", "dm-0"]) {
      b.series(
        "node_disk_read_bytes_total",
        { job, device, ...extra },
        base,
        end,
        counter(1024 * 1024, base, end)
      );
      b.series(
        "node_disk_written_bytes_total",
        { job, device, ...extra },
        base,
        end,
        counter(2 * 1024 * 1024, base, end)
      );
      b.series(
        "node_disk_reads_completed_total",
        { job, device, ...extra },
        base,
        end,
        counter(10, base, end)
      );
      b.series(
        "node_disk_writes_completed_total",
        { job, device, ...extra },
        base,
        end,
        counter(20, base, end)
      );
    }
    for (const device of ["eth0", "lo", "docker0", "br-1a2b", "veth9f"]) {
      b.series(
        "node_network_receive_bytes_total",
        { job, device, ...extra },
        base,
        end,
        counter(1000, base, end)
      );
      b.series(
        "node_network_transmit_bytes_total",
        { job, device, ...extra },
        base,
        end,
        counter(500, base, end)
      );
      b.series(
        "node_network_receive_packets_total",
        { job, device, ...extra },
        base,
        end,
        counter(10, base, end)
      );
      b.series(
        "node_network_transmit_packets_total",
        { job, device, ...extra },
        base,
        end,
        counter(5, base, end)
      );
    }
    for (const [name, value] of [
      ["MemTotal", 16e9],
      ["MemAvailable", 10e9],
      ["Cached", 3e9],
      ["Buffers", 1e9],
      ["SwapTotal", 2e9],
      ["SwapFree", 1.5e9]
    ] as const)
      b.series(`node_memory_${name}_bytes`, { job, ...extra }, base, end, () => value);
  }

  // Platform containers (ambient cAdvisor) plus a run-tagged duplicate.
  for (const job of ["cadvisor", "parkbench-run-platform-cadvisor"]) {
    const extra: Labels = job === "cadvisor" ? {} : { run_id: "run_a" };
    ["control-plane", "web", "prometheus", "grafana", "node-exporter", "cadvisor"].forEach(
      (service, index) => {
        const labels = {
          job,
          container_label_com_docker_compose_project: "parkbench-platform",
          container_label_com_docker_compose_service: service,
          ...extra
        };
        b.series(
          "container_cpu_usage_seconds_total",
          { ...labels, cpu: "total" },
          base,
          end,
          counter(0.05 * (index + 1), base, end)
        );
        b.series(
          "container_memory_working_set_bytes",
          labels,
          base,
          end,
          () => 100e6 * (index + 1)
        );
      }
    );
  }

  // Run-owned containers.
  const container = (
    runId: string,
    service: string,
    rate: number,
    from: number,
    to: number,
    options: { reset?: boolean; limit?: boolean } = {}
  ) => {
    const labels = {
      job: "parkbench-run-owned-cadvisor",
      run_id: runId,
      service,
      component: service
    };
    const cpu = counter(rate, from, to);
    const resetAt = from + 120;
    b.series("container_cpu_usage_seconds_total", { ...labels, cpu: "total" }, from, to, (t) =>
      options.reset && t >= resetAt ? cpu(t) - cpu(resetAt) : cpu(t)
    );
    b.series(
      "container_cpu_usage_seconds_total",
      { ...labels, cpu: "cpu00" },
      from,
      to,
      counter(rate / 2, from, to)
    );
    b.series(
      "container_cpu_usage_seconds_total",
      { ...labels, cpu: "cpu01" },
      from,
      to,
      counter(rate / 2, from, to)
    );
    b.series("container_memory_working_set_bytes", labels, from, to, () => rate * 1e9);
    b.series("container_memory_cache", labels, from, to, () => rate * 1e8);
    b.series("container_memory_swap", labels, from, to, () => 0);
    b.series("container_spec_memory_limit_bytes", labels, from, to, () =>
      options.limit ? 4e9 : 0
    );
    for (const metric of ["container_fs_reads_bytes_total", "container_fs_writes_bytes_total"])
      b.series(metric, { ...labels, device: "/dev/sda" }, from, to, counter(rate * 1e6, from, to));
    for (const metric of ["container_fs_reads_total", "container_fs_writes_total"])
      b.series(metric, { ...labels, device: "/dev/sda" }, from, to, counter(rate * 100, from, to));
    for (const metric of [
      "container_network_receive_bytes_total",
      "container_network_transmit_bytes_total"
    ])
      b.series(metric, labels, from, to, counter(rate * 1e5, from, to));
    for (const metric of [
      "container_network_receive_packets_total",
      "container_network_transmit_packets_total"
    ])
      b.series(metric, labels, from, to, counter(rate * 10, from, to));
  };
  container("run_a", "database", 0.8, runA.start, runA.end, { limit: true });
  for (let i = 1; i <= 11; i++)
    container(
      "run_a",
      i <= 2 ? `pas-${i}` : `svc${String(i).padStart(2, "0")}`,
      0.01 * (12 - i),
      runA.start,
      runA.end,
      { reset: i === 3 }
    );
  container("run_b", "database", 0.4, runB.start, runB.end);
  for (const service of ["pas-1", "loadgen", "pas-observer"])
    container("run_b", service, 0.05, runB.start, runB.end);

  // DB table operations: run A has 7 named tables plus `other`, with a tie at 5th place.
  const tables = (
    runId: string,
    window: { mStart: number; mEnd: number; start: number; end: number },
    rates: Record<string, number>
  ) => {
    for (const [table, rate] of Object.entries(rates)) {
      const labels = {
        job: "parkbench-runs",
        run_id: runId,
        service: "db-observer",
        database_epoch: "e1",
        table
      };
      b.series(
        "parkbench_openedge_db_table_operations_total",
        { ...labels, operation: "read" },
        window.start,
        window.end,
        counter(rate, window.mStart, window.mEnd)
      );
      b.series(
        "parkbench_openedge_db_table_operations_total",
        { ...labels, operation: "update" },
        window.start,
        window.end,
        counter(rate / 2, window.mStart, window.mEnd)
      );
      b.series(
        "parkbench_openedge_db_table_operations_total",
        { ...labels, operation: "create" },
        window.start,
        window.end,
        counter(rate / 4, window.mStart, window.mEnd)
      );
    }
  };
  tables("run_a", runA, {
    Customer: 50,
    Item: 40,
    Order: 30,
    Xb: 20,
    OrderLine: 10,
    Xa: 10,
    Xc: 5,
    other: 3
  });
  tables("run_b", runB, { Customer: 10, Item: 5, Order: 3, OrderLine: 2, other: 0 });

  // Tie-break bias, as the generated recording rules would produce it.
  ["Customer", "Item", "Order", "OrderLine"].forEach((table, index) =>
    b.series("parkbench:table_tiebreak_bias", { table }, base, end, () => (4 - index) / 10000)
  );

  // PAS observer.
  for (const [runId, window, replicas] of [
    ["run_a", runA, ["pas-1", "pas-2"]],
    ["run_b", runB, ["pas-1"]]
  ] as const)
    for (const replica of replicas) {
      const labels = { job: "parkbench-runs", run_id: runId, replica, service: "pas-observer" };
      const rate = replica === "pas-1" ? 100 : 50;
      b.series(
        "parkbench_openedge_pas_requests_total",
        labels,
        window.start,
        window.end,
        counter(rate, window.mStart, window.mEnd)
      );
      b.series(
        "parkbench_openedge_pas_failed_requests_total",
        labels,
        window.start,
        window.end,
        counter(rate / 100, window.mStart, window.mEnd)
      );
      b.series(
        "parkbench_openedge_pas_avg_abl_processing_seconds",
        labels,
        window.start,
        window.end,
        () => (replica === "pas-1" ? 0.01 : 0.04)
      );
    }

  const timeline = (
    runId: string,
    w: { start: number; mStart: number; mEnd: number; end: number }
  ): RunTimeline => ({
    runId,
    startedAt: w.start * 1000,
    endedAt: w.end * 1000,
    measurementStart: w.mStart * 1000,
    phases: [
      { phase: "warmup", start: w.start * 1000, end: w.mStart * 1000 },
      { phase: "measurement", start: w.mStart * 1000, end: w.mEnd * 1000 },
      { phase: "cooldown", start: w.mEnd * 1000, end: w.end * 1000 }
    ]
  });
  return {
    openMetrics: b.text(),
    base,
    runA,
    runB,
    timelines: {
      run_a: timeline("run_a", runA),
      run_b: timeline("run_b", runB),
      run_c: {
        runId: "run_c",
        startedAt: (base + 5000) * 1000,
        endedAt: (base + 5030) * 1000,
        phases: [{ phase: "warmup", start: (base + 5000) * 1000 }]
      }
    }
  };
}
