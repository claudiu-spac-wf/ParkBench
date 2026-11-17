# Current-history performance snapshot

Collect a read-only JSON snapshot from the running local platform:

```sh
node scripts/run-with-env.mjs node --import tsx scripts/reports/history-performance.ts /tmp/parkbench-history.json
```

The defaults are control API `http://127.0.0.1:13000/api/v1` and Prometheus `http://127.0.0.1:19090/api/v1`. Override them with `PARKBENCH_REPORT_API` and `PARKBENCH_REPORT_PROMETHEUS` (including `/api/v1`). The default output is `.parkbench/validation/feature026/history-report/data.json`.

The snapshot includes every history run, including failed or invalid measurements. It records run/execution identities, measurement windows, configured IOPS/latency, saved average CPU, scenario-selected table operation totals, paired primary/alternate buffer hit ratios, four grouped named-latch nap totals and captured startup/run-control parameters. Write scenarios count create/update/delete operations; read scenarios count reads. Numbered latch names combine before ranking, for example `MTL_BF1` through `MTL_BF4` become `BFN`. CPU uses 100% per core and sums PAS replicas.

Partial diagnostic values stay partial, unavailable data stays null, and disabled alternate pools carry a reason. Buffer ratios use matched observed counter intervals without crossing gaps or database epochs. Requested parameters without captured confirmation are labeled `(configured)`. Collection fails if history membership, state, update timestamps or execution revisions change during collection. This script does not modify runs, their validity, artifacts or scheduling.
