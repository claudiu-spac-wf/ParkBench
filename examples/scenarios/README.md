# Scenario examples

Scenario files may reference generated OpenEdge image and archive paths, but
licenses and Progress/JDK inputs are build-only references. Keep those private
values in an ignored env file or local command arguments.

The ParkBench scenario (`parkbench-bank-mix.json`) uses the `POST /work` handler on HTTP port 8810 and runs against any seed with the ParkBenchDB schema.
PASOE's WEB transport makes the full URL `/parkbench/web/work`; ParkBench keeps
the operation path as `/work` and adds the transport base path in generated
Compose configuration. Its body selects a procedure below `Workloads/` and
places all procedure-specific data inside `input`.

`parkbench-banking-writes.json` adds the routine write mix: 17 operations, 64% create and 36% update selections, with 11% selecting BLOB/CLOB writes. It includes wide customer/loan maintenance, narrow transaction/event creation, smaller exchange-rate/staff maintenance and LOB-bearing updates that preserve payloads. The default is one PAS replica and concurrency 1 with editable load settings and 30/120/10-second phases. Its operation seed is 2026; generated field values are not promised to repeat.

Writes persist in the run-owned database until cleanup. Prepare real parents and matching update subsets; finite code/composite capacity failures remain visible. Fixed indexed predicates can contend at higher concurrency. Band migration for this write scenario is deferred. See [scenario authoring](../../docs/scenario-authoring.md) and [table write inputs](../../docs/table-write-workloads.md).

## Short benchmark schedule

The existing smoke, calibrated-read and mixed presets use 30 seconds warmup, 120 seconds measurement and 10 seconds cooldown in their committed defaults. `parkbench-read-stable` uses the longer schedule described below. Adjacent phase boundaries share timestamps and observers keep collecting continuously. Startup, draining and cleanup are outside the phase schedule. Operator-authored custom durations and archived run evidence remain usable.

## Stable reads without LOB access

Select **ParkBench stable reads**, `parkbench-read-stable@1.0.0`, for a simpler read-only comparison. Each request selects only the existing `bank_mix.p` `range` path: one primary-index ordered read of up to 100 `DebitTransaction` rows, with no LOB fetches, write operations or timed repeat. `DebitTransaction` has no BLOB/CLOB columns. On a normal dense ParkBenchDB seed with at least 100 rows, every request traverses 100 transaction rows. Tiny or sparse seeds retain the workload's existing 1–100-row bounds; use the same dense seed across repetitions.

There is one operation, so the completed operation mix cannot drift between cheap reference lookups and expensive LOB requests. The existing generator chooses range starts across the table using seeded `key.sequence` values and `BenchmarkTableInfo.MaxId`, not a fixed first-row subset or a hard-coded seed-specific ID limit. Defaults are seed **2026**, **25** concurrent workers, one in-flight request per worker, one PAS replica, and **120 seconds warmup / 300 seconds measurement / 30 seconds cooldown**. Core, database, PAS and file observers remain enabled at five-second cadence. Phase generators restart from each worker's seed; matching seeds and worker counts replay each worker's request prefix, while timing still determines how many requests finish.

This preset uses the already shipped `Workloads/ParkBench/bank_mix.p` procedure; it needs no new workload binary or image rebuild when that procedure is already present in the selected final image/archive. Its shared readiness check still requires the banking workload's declared tables, `BenchmarkTableInfo`, indexes and `SeqAuditLogId`, even though the scenario never selects its audit-write branch. Native summaries can include metadata reads and observer activity in addition to the 100 transaction rows per request.

This measures one table's indexed range-read throughput. It has no calibrated 9 GB eligible footprint and is separate from the calibration generator. Larger caches can contain this smaller working set; HTTP/PAS overhead, memory limits, OS caching and normal host noise can still limit throughput. The preset reduces workload variation but does not promise identical results. Compare repeated runs of this preset with the same seed, concurrency and memory settings; use the completed 300-second measurement window.


## Calibrated reads and mixed presets

`parkbench-read-mix.json` admits about 9 GB of unique eligible record/requested
LOB data on the reference `twentyeight_gb_lnx` seed. Its verified cutoff is
`RandomInt1000 <= 870`; each request uniformly samples a complete bucket from
1 to 870 without row truncation or a cumulative read quota.

| Preset | Read/write selection probabilities |
| --- | --- |
| `parkbench-read-write-90-10.json` | 90% / 10% |
| `parkbench-read-write-80-20.json` | 80% / 20% |
| `parkbench-read-write-70-30.json` | 70% / 30% |

Each mix has 16 reads and 17 writes with unchanged operation inputs, concurrency 10, one in-flight
request per worker, one PAS replica, seed 2026 and a 60000ms request deadline.
Ratios include failed attempts; successful counts and transaction/byte/time
shares can differ. The standalone read and write presets remain available.
Exactly eight scenario JSON files are discovered, including the independently authored stable read preset. Calibration evidence is kept
outside that directory.

Regenerate and check without native tooling or a host-specific seed path:

```sh
node scripts/openedge/generate-benchmark-scenarios.mjs
node scripts/openedge/generate-benchmark-scenarios.mjs --check
```

These commands validate committed report/profile/output consistency and report
`reference seed not reverified`. Reference native acceptance first verifies the
actual starting seed. See [calibration guidance](../../docs/benchmark-read-calibration.md)
for measured bytes, fingerprints, refresh procedure and a block-size-aware
combined 8 GiB cache budget. Verification does not restrict production runs or
comparisons using other seeds or scenarios.

Earlier native acceptance on the configured 28GB Linux reference completed2026-10-02:
standalone reads and all three mixes finished their30/120/10 schedules with
continuous DB table/index and active/free observations. All four final runs
succeeded with complete required resource coverage, unchanged source and owned
cleanup. Evidence: `.parkbench/validation/feature019/benchmark-scenarios.json`.
These acceptance runs used a2GiB containment limit; their throughput is validation
evidence, not an8GiB-cache performance baseline. Actual counts and optional
insufficient-data warnings remain retained. Interrupted and INCOMPLETE attempts
are preserved separately.

After integer weight scaling, all three affected mixes reran sequentially against
fresh copies of the verified reference. 90/10 and 70/30 succeeded. 80/20 retained
THRESHOLD_FAILED from one HTTP500 banking write in cooldown; measurement had
zero operation errors. All three had complete required coverage, continuous
native observations, unchanged source and complete owned cleanup. The unchanged
standalone read acceptance is reused. Current evidence is
`.parkbench/validation/feature019/convergence/summary.json`; earlier reports retain
their original outcomes.
