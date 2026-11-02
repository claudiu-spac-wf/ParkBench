# Investigating missing measurements

A successful workload, complete observer heartbeat count and complete source data are separate claims. Start with the exact run, phase and measurement identity. Compare scheduled acquisition slots, native source timestamps/generations, stored Prometheus readings, saved statistics and the executed Grafana query. A zero requires an actual reading; a missing reading stays missing.

## Collect bounded evidence

Scheduling accepts `measurement-diagnostics-config.v1` with `mode: summary` or `mode: trace`. Summary is the default and retains acquisition/stage aggregates, expected measurement inventory, findings and query references. Trace additionally retains bounded timing events. Neither mode archives raw readings, native response bodies or private setup source. Prometheus remains the time-series store.

The seven settings and validated bounds are in [operator configuration](operator-configuration.md#measurement-diagnostics-bounds). They freeze before provisioning. Capacity covers all producers and later audit attempts for that run; expiry and restart do not refill it. The defaults are 8 MiB summary, 32 MiB trace, 1 MiB pending, 4 KiB per event, 1 s normal flush and 7 days trace TTL. Select sufficient summary capacity for the independently expected inventory before a campaign: a large native inventory can exceed the default. Raising a limit after a truncated run does not repair that run's evidence.

History exposes diagnostic manifests, inventory/findings pages and retained trace as run artifacts. Check recording state, every needed producer's collection/flush state, dropped events, write failures and incomplete inventory/findings. An unavailable/truncated attempt cannot establish complete coverage or causation. Diagnostic loss and workload quality are reported separately.

## Run a controlled investigation

Run commands from the application repository after building its TypeScript output. Keep campaign files under ignored `.parkbench/validation/feature024/`. The helper uses normal preview, paged review, submit, queue, history and artifact APIs; it does not own a second scheduler.

```sh
node scripts/diagnostics/measurement-campaign.mjs inventory \
  --campaign .parkbench/validation/feature024/example.json
node scripts/diagnostics/measurement-campaign.mjs declare \
  --campaign .parkbench/validation/feature024/example.json \
  --declaration .parkbench/validation/feature024/example-declaration.json
node scripts/diagnostics/measurement-campaign.mjs declare-hypothesis \
  --campaign .parkbench/validation/feature024/example.json \
  --declaration .parkbench/validation/feature024/example-hypothesis.json
node scripts/diagnostics/measurement-campaign.mjs run \
  --campaign .parkbench/validation/feature024/example.json \
  --configuration read-no-setup --count 1 \
  --hypothesis H-example --change one-declared-change
node scripts/diagnostics/measurement-campaign.mjs resume \
  --campaign .parkbench/validation/feature024/example.json
node scripts/diagnostics/measurement-campaign.mjs assess \
  --campaign .parkbench/validation/feature024/example.json
```

A declaration contains the versioned campaign plus its existing experiment requests. Freeze scenario/seed/setup references, startup settings, load, phases, each cadence, diagnostic bounds, actual deployed image IDs and independent expectations. Before each investigation batch declare its discriminating hypothesis/control and next decision. Preserve failed and inconclusive attempts. Resume reconciles recorded identities without resubmitting or replaying setup. If unrelated work appears, the helper stops further submissions; do not clear that work.

## Reconcile sources and charts

Use original source timestamps rather than scrape evaluation grids to assess coverage. Two requests can share one native capture; its generation and timestamp identify one observation. The owned continuous phase clock allows a real capture from the current native interval to serve concurrent requests. A new interval or phase excludes old captures; unknown timestamps do not authorize cache reuse. Missing/malformed clocks fall back to conservative request freshness. Health checks have a separate cache contract.

The control plane reads the owned native Prometheus target's actual healthy scrape clock before warmup. It aligns measurement start 250 ms before the next five-second scrape by shifting the whole adjacent phase schedule; phase durations and workload remain unchanged. This prevents the demonstrated delayed-admission race from crossing a native source interval and skipping an already completed generation. The run snapshot records the fixed `native-scrape-alignment.v1` clock metadata. Source values, source timestamps, sampling intervals, child deadlines and quality checks remain unchanged.

cAdvisor v0.55.1 adds up to one base interval of scheduling jitter even with dynamic housekeeping disabled. Resource edge calculations therefore use twice the configured housekeeping base as the known source-age component. With a five-second scrape and one-second housekeeping base, up to seven seconds at an edge may be explicitly estimated under the existing model. Actual acquisition counts and observed contributions stay separate; the interior gap rule, missing members and larger gaps remain unchanged.

The pinned exporter stores only the nine Docker labels used for ownership and run lineage: Compose project, service and container number, plus ParkBench managed, run, experiment, variant, repetition and component. Native id, name, image, CPU, device, interface and major/minor dimensions remain. This bounds repeated metadata in exposition without changing metric families, values, timestamps, collection intervals or scrape deadlines.

Resource accounting must preserve all physical members and devices. An empty device name is an unresolved identity, not a reported aggregate. Explicit device totals suppress duplicate device contributions only when the exporter actually reports a total. Missing per-device readings remain gaps unless the run's recorded source profile and independent native inventory prove a complete cgroup snapshot. Filesystem-series absence alone never proves earlier zero activity or a device's lifetime.

Disabled alternate buffer pools, a proven synthetic empty table row and a directory's unsupported file-size reading are examples of independently justified limitations. They are scope-specific. They do not excuse another table, a real zero reading, allocated directory bytes, an index or an enabled pool. Dynamic `not_applicable` must agree at each source timestamp.

An owned container can have an empty kernel I/O accounting inventory while CPU and memory remain available. This does not establish a zero disk reading. For this case, capture independent device availability before measurement starts:

```sh
node scripts/diagnostics/capture-measurement-device-state.mjs --run-id RUN_ID
```

The command reads kernel and cAdvisor inventories for all six platform services and the current run’s database/PAS containers through the existing cAdvisor container, outside the measured containers. It verifies the Docker identity, cgroup2 filesystem and direct target PID membership before reading kernel I/O accounting; a container’s mounted `/sys` alone does not establish ownership. Two asynchronous workers bound concurrent target reads and preserve discovery order. It stores only identities, timestamps, field names and nonzero flags in `confirmation-kernel-RUN_ID.jsonl` under the campaign evidence root. Records are limited to 4 KiB, the file to 8 MiB and 8,192 records; each poll waits one second plus its actual capture time. It refuses an existing output file. Raw counter values and private configuration are not retained.

The campaign audit can explain a platform disk limitation only with complete owned kernel/native evidence across the exact window, no contradictory stored disk points and independently complete contributions from every other member. Saved nulls, partial totals, acquisition counts, missing duration and quality remain unchanged. Missing or stale evidence, a different owner or any lost healthy contribution still blocks acceptance. Verification reopens the metadata and repeats that source audit. Historical runs without the recorded source profile are not retrospectively classified from later state.

Some published Top N panels deliberately omit zero-activity series. Inspect the executed query before treating an omitted series as lost data. A zero in a source-aware summary or a zero-valued bar remains distinct from an unavailable reading.

Comparison CSV appends `definition_id`, `operation`, `file` and `scope` to preserve semantic identity, including BI read versus write. Match identity, values, statistic status and coverage across saved results, comparison API and CSV.

Capture actual Grafana panels with their executed query/step, window, timezone and source evidence:

```sh
node scripts/diagnostics/capture-measurement-charts.mjs \
  --declaration .parkbench/validation/feature024/panels.json \
  --output .parkbench/validation/feature024/charts
```

The optional `--concurrency 1` through `--concurrency 4` bounds independent panel captures; the default is 1. For acceptance, capture while the benchmark queue is idle. Each selection retains its success or bounded failure record, and any failed selection makes the command exit nonzero.

The declaration's `panels` array selects run ID, dashboard UID, panel ID, phase, start/end milliseconds, timezone and origin. Capture both the rendered panel and Query Inspector. Assess the full affected panel inventory for every accepted run; a few clean screenshots are supporting checks only. Re-audits retain old attempts and choose one current capture per panel. Verification uses the exact accepted references and rejects missing, truncated or corrupt PNG evidence.

Global platform queries retain their lack of run labels. An optional memory-limit curve may be empty only when an independent audit of every platform member proves no configured limits throughout the executed window. Absence alone cannot prove this. Frame counting includes all returned frames within the 8 MiB and 500,000-point bounds.

## Confirm a repair

Demonstrate the mechanism, retain an independently defined regression failing before repair, run relevant checks, then idle-deploy and verify the actual repaired images before live validation. Repeat the trigger with unchanged load, cadence and quality rules. Keep genuine faults and partial statistics visible. Measure callbacks-only-disabled versus retained-summary overhead for both workload classes, then summary versus trace; repeat inconclusive comparisons. Controls never count toward final acceptance.

A confirmation declaration needs read-only and mixed workloads, each with and without the declared setup. The user-approved feature024 acceptance campaign requires five accepted fresh base runs covering all four combinations with one base repeat, plus three per additional diagnosed trigger. Further repetition is deferred to ordinary use. Rejected/inconclusive attempts reset the affected sequence; relevant repairs invalidate dependent passes. Final acceptance additionally requires complete supported source/statistic coverage, actual affected panels, saved/comparison/CSV agreement, diagnostic evidence, cancellation/loss checks, overhead, history/restart, privacy/retention and actual owned cleanup.

```sh
node scripts/diagnostics/measurement-campaign.mjs verify \
  --campaign .parkbench/validation/feature024/confirmation.json
```

`verify` exits nonzero when required evidence is missing. A successful investigation run does not establish final confirmation. Source retention and diagnostic retention are separate: screenshots/metadata cannot recover expired time series.

## Recover evidence accounting

For a terminal run with COMPLETE owned cleanup and an idle scheduler, [explicit conservative budget recovery](operator-configuration.md#conservative-recovery-of-an-unavailable-diagnostic-budget) can settle uncertain reservations. It charges their full allocation and a separate append-only receipt. It does not restore lost events, modify original manifests, change measurement quality or make an unavailable attempt acceptable.

Open findings pin needed trace. Confirmed expiry appends retention records while keeping sealed manifests and committed lifetime usage unchanged. Unexplained missing files are unavailable evidence, not confirmed expiry. A historical kernel state that was never recorded cannot be reconstructed from later absence; keep its attribution limit explicit.

Real-source runs record `sourceCadences.cadvisorDiskAccountingProfile` as
`cadvisor-complete-disk-frame.v1`. Disk summaries and required-source checks use the
separate native major/minor Read/Write inventory to validate complete cgroup
snapshots. A device-accounting entry appearing during measurement contributes its
first real cumulative value to that snapshot's aggregate. No device zero or past
reading is created. Raw per-device acquisition counts remain distinct from derived
cgroup-frame counts; expected readings use independently observed native entry
availability and the configured cadence.

Missing companion inventory, ambiguous device labels, missing expected readings
and counter/source-epoch changes keep results partial or unavailable. Native
major/minor identities govern continuity even when display names change. Historical
runs without the recorded profile keep their original accounting and saved values.
The bounded diagnostics retain source/count/scope references without raw values.

The native database observer exposes `GET /native-capture-status` on its internal HTTP port. This read never starts a capture. The `measurement-native-capture-status.v1` response identifies the run, process instance and collection source, and retains at most 64 failure records in volatile memory, including when callback recording is disabled. It distinguishes child deadline, exit/signal, unavailable executable, output bounds, connection capacity and normalization failures. Records include only timing, generation, fixed classifications, byte count and whether the rejected output contained a contract-valid frame. No child output, command arguments, error text or measurement values are retained. A complete frame from a failed child remains rejected. Check `historyComplete`, dropped/rejected counts and owner identity before using this status as evidence; cleanup or restart removes it. Native HTTP capture failures return a fixed error body.

The native observer writes its complete JSON protocol through a buffered stream using the native UTF-8 serializer. This avoids the default terminal stream's per-character writes and preserves non-ASCII identities. The copier is a fixed in-container command with no input file arguments; snapshots flow directly to stdout. The existing five-second child deadline and eight-MiB output bound remain unchanged. A child failure still rejects its output even if that output contains a parseable frame. See the [OpenEdge JSON stream writer](https://docs.progress.com/bundle/openedge-abl-reference-128/page/WriteStream-method-JsonObject.html).

For successful-capture timing with callbacks disabled, the native observer also exposes GET /native-capture-timing. The separate measurement-native-capture-timing.v1 response retains process/normalization timings, successful source timestamps and metrics-response generation/floor/status metadata. It holds at most512 events and120KiB of event records in memory; the response is bounded to128KiB. Counts identify dropped or rejected timing records. It retains no readings, bodies, command arguments, arbitrary paths or request headers. Reading either status endpoint starts no acquisition. Collect this volatile evidence before cleanup; a request classified UNKNOWN stays unknown.
