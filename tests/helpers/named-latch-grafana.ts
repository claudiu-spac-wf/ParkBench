/** Native timestamp fixture: measurement deltas are 10/30/0 naps and 2/5/0 seconds. */
export function namedLatchOpenMetrics(start: number, end: number, runs = ["native-a", "native-b"]) {
  const families = new Map<string, string[]>();
  const add = (metric: string, labels: Record<string, string>, value: number, time: number) => {
    const rows = families.get(metric) ?? [];
    rows.push(
      `${metric}{${Object.entries(labels)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(",")}} ${value} ${time}`
    );
    families.set(metric, rows);
  };
  for (const run of runs)
    for (const [name, type, id, waits, duration] of [
      ["buffer", "shared", "1", 10, 2],
      ["transaction", "exclusive", "2", 30, 5],
      ["idle", "shared", "3", 0, 0]
    ] as const) {
      for (let time = start - 10; time <= end; time += 5) {
        const phase = time < start ? "warmup" : "measurement";
        const labels = {
          run_id: run,
          phase,
          service: "database",
          job: "parkbench-runs",
          database: "actual-db",
          database_epoch: "named-epoch-a",
          latch_name: name,
          latch_type: type,
          latch_id: id
        };
        const fraction = Math.max(0, (time - start) / (end - start));
        for (const [metric, value] of [
          ["latch_named_waits_total", 100 + fraction * waits],
          ["latch_named_wait_or_spin_duration_seconds_total", 50 + fraction * duration]
        ] as const) {
          add(`parkbench_openedge_db_${metric}`, labels, value, time);
          add(
            "parkbench_openedge_db_metric_available",
            { ...labels, measurement: metric, family: "latch", reason: "available" },
            1,
            time
          );
          // Duplicate controller publishers must never change arithmetic.
          add(
            `parkbench_openedge_db_${metric}`,
            { ...labels, job: "parkbench-control-plane" },
            99999,
            time
          );
        }
      }
    }
  for (const [run, epoch, waits, duration] of [
    ["native-reset", "reset-epoch", 7, 0.7],
    ["native-epochs", "epoch-one", 10, 2],
    ["native-epochs", "epoch-two", 30, 5]
  ] as const) {
    for (let time = start; time <= end; time += 5) {
      const labels = {
        run_id: run,
        phase: "measurement",
        service: "database",
        job: "parkbench-runs",
        database: "actual-db",
        database_epoch: epoch,
        latch_name: "identity-case",
        latch_type: "shared",
        latch_id: "native-1"
      };
      const fraction = (time - start) / (end - start);
      const resetProgress = Math.max(0, (time - start - 5) / (end - start - 5));
      const count =
        run === "native-reset"
          ? time === start
            ? 100
            : 2 + Math.floor(resetProgress * 5)
          : 100 + fraction * waits;
      const seconds =
        run === "native-reset"
          ? time === start
            ? 50
            : 0.2 + resetProgress * 0.5
          : 50 + fraction * duration;
      for (const [measurement, value] of [
        ["latch_named_waits_total", count],
        ["latch_named_wait_or_spin_duration_seconds_total", seconds]
      ] as const) {
        add(`parkbench_openedge_db_${measurement}`, labels, value, time);
        add(
          "parkbench_openedge_db_metric_available",
          { ...labels, measurement, family: "latch", reason: "available" },
          1,
          time
        );
      }
    }
  }
  return [...families.values()].flat().join("\n") + "\n";
}
