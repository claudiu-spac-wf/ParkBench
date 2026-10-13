# Operator runbook

## Ubuntu setup and recovery

The initial supported migration profile is Ubuntu 26.04.1 LTS on x86_64. Use
Node.js 24 or later. ParkBench uses the Engine selected by the Docker CLI and
does not require a named context. Docker and Compose versions are recorded as
observed values; setup gates their commands and capabilities rather than exact versions. Run
`./scripts/bootstrap.sh` from the
ParkBench repository after configuring `.env.local` and supplying the licensed
OpenEdge assets, license, imported DB/PAS/JDK images, and executable compiler
adapter locally.

Bootstrap runs `node scripts/host-preflight.mjs` and the OpenEdge all-stage
preflight before `npm ci`. It records the sanitized host profile at
`.parkbench/host-environment.json` and the attempt result at
`.parkbench/bootstrap-readiness.json`. `valid` is true only when all six
platform services are ready: control plane, web UI, Prometheus, Grafana,
cAdvisor, and node exporter. On failure, use `stage`, `component`,
`diagnosticLog`, and `recoveryAction` from that JSON, then inspect the retained
redacted log. Correct the local setting/input and rerun bootstrap. Keep
`.env.local`, licensed files, previous run evidence, and unrelated containers,
images, and volumes in place.

Final Ubuntu acceptance also requires the licensed OpenEdge smoke run with disk
I/O checks enabled. A fake smoke run validates local lifecycle behavior but
does not establish licensed OpenEdge acceptance.

ParkBench-owned commands automatically load `.env.local` from the repository
root. Use `npm run preflight -- --config .env.local` when you want to make the
environment file explicit before a licensed run. Use `./scripts/compose.sh`
for generic Compose actions so the selected file and Docker target are passed
consistently. Relative host paths resolve from the repository root. The
containerized control plane sees files below
`PARKBENCH_DOCKER_HOST_PATH_ROOT` at `/var/lib/parkbench`; seed, archive, and
manifest inputs used by runtime operations must be under that root. Inspect
the control plane at `http://127.0.0.1:13000`, Prometheus at port 19090,
Grafana at port 13001, cAdvisor's web UI at port 18080, and the web UI at
port 13002. Override these host ports with `PARKBENCH_*_HOST_PORT` in
`.env.local`; `scripts/start.sh` and `scripts/status.sh` print the actual
endpoints. A required cAdvisor or node-exporter block-device source
must be available before resources are created. Measurement gaps produce
`INCOMPLETE`; export failures preserve diagnostics and produce `FAILED` with
unavailable measurement validity. If the platform runs in Docker, configure the
absolute host data and Docker path roots before starting it so generated run
Compose mounts are visible to the Docker daemon.

Set `PARKBENCH_DOCKER_SOCKET_PATH` in `.env.local` when the Engine socket is not
at `/var/run/docker.sock`. Optional `PARKBENCH_PLATFORM_CPUSET`,
`PARKBENCH_PAS_CPUSET`, and `PARKBENCH_DB_CPUSET` values use Docker CPU IDs and
ranges (for example, `0-3`, `4,5`, and `6,7`). Keep the configured groups
non-overlapping; empty values leave those services unpinned. Docker CPU sets
constrain each container but do not reserve CPUs globally, so pin unrelated
competing containers to other CPU IDs as well.

## Parameter runtime contract

The versioned `parameters.v1` adapter writes validated factors into each run
bundle. Database images MUST consume `PARKBENCH_OPENEDGE_DB_STARTUP_ARGS` as a
JSON string array of startup arguments before opening the database, and
`PARKBENCH_DATABASE_READ_ONLY` when that factor is declared. PAS images MUST
consume `PARKBENCH_PAS_MAX_THREADS` when that factor is declared. The same
values are retained in `PARKBENCH_EFFECTIVE_CONFIGURATION` and the immutable
run snapshot. An image that does not implement this contract is not a valid
benchmark image; these variables are not cosmetic hints.

CPU limits are applied through generated Compose service resource limits. CPU
sets pin platform helpers, each PAS target, and the database to operator-chosen
CPU IDs; the groups must not overlap. Baseline and variant bundles may differ
only in the declared parameter factor and its resulting runtime resource setting.

## Database Latency

`network.databaseLatencyMs` (0–1000, default 0) adds a one-way network delay of
N ms in **each direction** between every PAS replica and the database, so each
PAS↔database round trip grows by about 2N ms. Set it in the scheduling screen as
"Database latency (ms)" (one value for every run) or choose it as a matrix
dimension (for example `0, 5, 20`).

For N > 0 the run Compose project gains a `latency-database` and one
`latency-pas-<n>` sidecar. Each reuses the observer image (which must include
`iproute2`; rebuild and re-tag it after upgrading), shares its target's network
namespace and holds `NET_ADMIN`. After readiness and before the load generator
starts, ParkBench measures a TCP-connect baseline from `pas-1` to the database
broker port (resolved once and probed by IP after a warm-up connection), installs a `prio` + `netem` qdisc with `u32` destination filters
(only traffic to the peer IPs is delayed, on every port; observer, load
generator and metrics traffic is not), and measures again. The run continues
only when the round trip grew by 2N ± max(10% of 2N, 1 ms); the result is
recorded as `db-latency.v1` in the run snapshot and the `database-latency.json`
artifact and shown in Queue, History and Comparison.

| Failure code | Meaning | Fix |
|--------------|---------|-----|
| `database_latency_unsupported` | The host kernel lacks netem, prio or u32 traffic control | Load `sch_netem` (`sudo modprobe sch_netem`) or run without Database Latency |
| `database_latency_apply_failed:<target>` | A sidecar could not resolve a peer or run `tc` | Check that the observer image includes `iproute2` and the sidecar logs |
| `database_latency_unconfirmed` | The measured round trip did not grow by about 2N | Check host load; repeat the run |

All three fail the run before warmup; a run never continues silently without the
requested latency. The qdiscs live in the run containers' network namespaces and
disappear when the run is cleaned up. Every round trip grows by 2N, so above
about 100 ms one way high-volume operations can approach the 60 s request
timeout: lower their `Limit` or raise `-prefetchNumRecs`/`-Mm` in the same
matrix. Fake-mode runs record the value with `status: simulated`.

## OpenEdge image stages and workload requests

The generic OpenEdge image is reusable runner plumbing only. It must not be
selected as the PASOE image for ParkBench. Build `--image-stage final` (or
`all`) after adding procedures under `openedge/workloads/Workloads`; the root
manifest must say `imageStage=final` and `parkBenchReady=true`. If a final
archive has a malformed procedure, an invalid `SingleParam AS LONGCHAR`
signature, or an uninspectable image, the builder emits no successful root
outputs.

The only business endpoint is `POST /work`, with `{procName,input}` as its
complete JSON envelope. Invalid JSON, unsafe paths, missing procedures, and
procedure failures are bounded `4xx`/`5xx` workload errors and do not count as
successful operations. The runner and load generator use a 60000 millisecond
deadline. A bounded timeout response and a request that receives no response
by that boundary have the same meaning: stop load, mark the owning run
`FAILED`, retain diagnostics and a partial saved summary, and then clean up. The
timeout is a lower-bound observation (at least one minute), not a completed
latency and not an upper bound. A non-cooperative procedure may remain until
PASOE resource teardown.

If the build reports a missing JDK, license, Progress package tree, mutable or
latest image, malformed archive, or missing workload root, correct the local
input and rerun preflight. Explicit tags are
required. Never place those private inputs in Git. If the DB broker or
observer is unready, confirm the seed's database name (`parkbench`), `database`, broker `20931`, dynamic
ports `20932-20941`, the `/psc/wrk` mount, and the read-only observer launcher.

Each newly finalized run registers one immutable `run-summary.v1` artifact at
`<run>/summaries/measurement-summary.v1/<attempt>/comparison-summary.v1.json`.
Use the History artifact link or `GET /api/v1/runs/:runId/comparison-summary` to
find the current registered path. The summary records actual measurement
boundaries, saved statistics, units, coverage, workload outcomes, observer
health, cleanup and bounded Prometheus query references. `run-context.v1.json`
preserves the scenario, requested/effective/observed parameters, input
references, deterministic seed, image manifests, host/tools and diagnostics.
The retained `db-parameter-snapshot.json` holds plaintext startup values,
verification results and the actual UTC capture time. Compose files, service
logs and failure/cleanup diagnostics remain separate useful artifacts.

New runs do not generate `summary.json`, `observer-report.json` or
`run-evidence.json`. Historical reports and exports stay accessible. Raw
series remain solely in Prometheus; choose `PARKBENCH_PROMETHEUS_RETENTION`
for diagnostic chart history. Expiring those series does not remove a READY
saved summary. Required source gaps mark a measurement incomplete; supported
partial values remain inspectable. A failure to save the summary reports
explicit diagnostics rather than a usable result. Cleanup recovery is safe
to retry.

## Control UI quick path

1. Open the local Control UI and inspect Catalog assets.
2. Verify or build the required explicitly tagged database/PAS/workload/observer
   assets. Do not paste credentials or private input contents into the UI.
3. Select a scenario version and edit only declared, non-secret parameters.
4. Preview the experiment. Review the warning, cell order, run count, and
   effective values before confirming.
5. Start the queue. Preflight runs before any benchmark resources are created.
6. Monitor lifecycle, health, completeness, retry state, and terminal evidence.
7. Use Comparison to select a baseline, or leave it empty to inspect selected runs.
   Failed and incomplete runs retain values and reasons; differences require
   both measurements to be successful, valid and complete.
8. Use History for retained summaries, diagnostics, cleanup, and provenance.
   Prometheus holds each run's time series; Grafana visualizes them.

Temporary capacity is retried at 5, 15, 30, and 60 seconds while remaining
queued. Permanent configuration/capacity failures become blocked and require
operator correction. The application is English-only and is not presented as
formal WCAG-conformant.

## Grafana dashboards

ParkBench provisions ten generated dashboards in three actual Grafana folders:

| Folder    | Dashboards                                                                                    |
| --------- | --------------------------------------------------------------------------------------------- |
| Resources | Host Resources, Platform Resources, Run Resources, Run Summary                                |
| Database  | DB Resources, Database Activity, Database BI & APW data, Database transactions, locks, and latches, Database Parameters |
| PAS       | PAS Instances                                                                                 |

Host/platform diagnostic charts use ambient exporters. Component views use
selected run identities, optional phase/object filters and canonical `pas-N`
replicas. Run Resources can investigate all run containers; saved comparisons
have disjoint Platform, Database and PAS groups and exclude load generators
and observers from Database/PAS totals.

Container CPU uses 100% per logical core and can exceed 100%; host CPU keeps
its share-of-host convention. Used memory is working-set bytes, with cache,
swap, limits and native buffers separate. Disk/network directions and
byte/operation totals remain distinct. Native database totals and totals over
covered tables have separate scopes.

Measurement tables show the persisted average/p90/p95/total over the recorded
measurement window. Narrowing a chart does not recalculate those values.
Rate/increase charts are diagnostic views over their displayed range.
Default table charts rank up to ten actual names independently for reads,
writes (create + update + delete), and other operations, with fixed membership
per run/window. The display Other contains complementary supported activity;
it is never saved as a native table. Full-table/index drill-down remains
available. Comparison pages and streamed CSV include every saved table,
including a genuine collected Other bucket, and do not apply a top-ten filter.

With one run selected, run-scoped dashboards show real clock time in UTC. With
several runs selected, the runs are aligned on elapsed time since each run's
measurement phase started. The axis reads `00:00:00` at measurement start, and
warmup comes before it. If the runs are changed inside Grafana, a notice
appears. Use **Reset range to selected runs** in the dashboard links to
recalculate the range. Runs that never reached measurement are listed as
excluded from the aligned charts.

The dashboards are generated. Edit `packages/dashboards/src/`, then run `npm run
dashboards:build`, never the JSON in `deploy/grafana/dashboards/{Resources,Database,PAS}/` directly. `npm
run dashboards:check` fails if the committed files are out of date. The link bar
points at the web UI's `/api/v1/grafana/open` redirect, using
`http://127.0.0.1:13002` by default. If the web UI is published elsewhere, build
with `PARKBENCH_WEB_URL=<url> npm run dashboards:build`.

The run-scoped dashboards use the **ParkBench Runs** data source. It is a
read-only, Prometheus-compatible API served by the control plane at
`/api/v1/grafana/prom`, and its health endpoint is `/api/v1/grafana/health`. The
API rejects any query in which a selector lacks a literal `run_id` filter. The
old `parkbench-database-resources` dashboard is retired, and links to it
redirect to DB Resources.

Existing `parkbench-benchmark-overview` and `parkbench-overview` ParkBench links
resolve to Run Summary. The old combined recovery/concurrency UID now opens
Recovery; Concurrency has its own UID. Saved legacy panel references map to
their replacement without rewriting historical artifacts. The single existing
provider derives folders from nested files and retires only named managed
root definitions. Unrelated manual dashboards are preserved.

On first comparison access, historical runs with trustworthy boundaries and
retained compatible series enter RECOMPUTING. One leased worker saves the
corrected semantic version. READY values are reused; LEGACY means the old
meaning or boundaries cannot be reconstructed, and UNAVAILABLE names missing
or expired sources and retryability. Poll using Retry-After. A pending CSV
returns 409 with `comparison_summary_pending`; retry the same comparison ID.
Selections and table/run results are independently paged. Stale revision or
published-attempt cursors require restarting that page traversal.

For the ordinary, pinned Prometheus/Grafana, performance, browser and licensed
verification commands, see the sibling planning repository's
[feature 015 quickstart](../../ParkBenchPlanning/specs/015-fix-metrics-comparisons/quickstart.md).
Licensed verification requires final protocol-3 observer images and a ready
seed containing more than 64 supported tables. The three matched Docker/cgroup
windows are test attachments; inspect them to establish a live memory cause.
