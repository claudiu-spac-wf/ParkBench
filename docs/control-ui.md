# ParkBench Control UI

The Control UI is the local operator surface for catalog preparation, scenario
configuration, matrix scheduling, queue control, live monitoring, comparison,
Grafana context, and run history.

## Overview and catalog discovery

The Overview screen is the operational home. It reports SQLite, Docker, and
Prometheus health, the current queue, recent terminal runs, and a summary of
catalog discovery. The Catalog screen separates Docker images, scenarios,
workloads, observers, seeds, archives, and configurations into tabs.

Catalog discovery runs on startup and can be refreshed from the UI. Docker
images are read from the local Docker daemon; managed file roots are configured
with `PARKBENCH_DISCOVERY_*_ROOT` variables. Missing roots are shown as empty,
unreadable sources are shown as degraded, and malformed scenarios remain
visible for diagnosis but are not selectable. Discovery records contain path and image-reference provenance without private file contents or secret labels.

Every editable field has an `i` help control. Focus, hover, click, and tap open
the tooltip; Escape or clicking outside closes it. Only one help tooltip is
open at a time.

## Start locally

Run the control plane and the web development server from the repository root:

```bash
npm run dev --workspace @parkbench/control-plane
npm run dev --workspace @parkbench/web
```

The UI calls the control-plane API under `/api/v1`. The control plane binds to
the configured local host; it must not be exposed beyond the trusted benchmark
host. Use explicit non-`latest` image tags. File inputs use path-based `input:` references. Secret values are deliberately
never accepted as UI-editable parameters or returned in UI payloads.

## Matrix workflow

Preview a matrix before submitting it. Every valid matrix displays a warning
and requires explicit confirmation. Dimension order is deterministic. For
example, four `-B` values crossed with four `-B2` values creates 16 cells; a
repetition count creates additional runs in cell order. Previews expire after
five minutes and submission checks the preview ID, confirmation, and `Idempotency-Key`.

Submission does not choose a baseline. The Comparison screen lets the operator
select runs across experiments, workloads, scenarios and configurations. Browsing
another experiment preserves the selected runs and optional baseline. Without a
baseline, the screen shows run values. With one, corresponding available numeric
values produce differences even for failed or incomplete measurements; absent
values stay unavailable and a zero baseline has no percentage difference.

Recorded run status, measurement quality and coverage remain visible. Operators
are responsible for interpreting comparisons, which may be misleading. Different
recorded scenarios produce only a nonblocking warning; comparison does not require
matching inputs, successful runs, complete measurements or an override. Saved
selection pages, table results, CSV exports and linked dashboards use the same
exact selected runs.

The **Database latency (ms)** field applies one one-way PAS↔database delay to
every run of the submission; choose `network.databaseLatencyMs` as a dimension
instead to compare several values (the field is then disabled). Preview cells
show non-zero values as `Latency N ms (≈2N ms RTT)`; values above 100 ms show a
timeout warning. History, Queue and Comparison show each run's latency and its
confirmation status, and the History parameter filter accepts
`network.databaseLatencyMs=<n>` (runs from before the feature match `=0`).

## Queue and evidence

Queue start performs preflight before resource creation. A temporary capacity
condition stays queued and records the 5/15/30/60-second retry schedule.
Permanent configuration/capacity failures are blocked with diagnostics. Run
terminalization retains summaries, raw time-series exports, diagnostics, and
cleanup status before owned resources are removed.

Metrics collection continues through warmup, measurement and cooldown on one
shared clock. Warmup ends when measurement starts, and measurement ends when
cooldown starts. Target readiness finishes before warmup; phase transitions
keep the same Prometheus targets and scrape cadence. Infrastructure and native
observer series span all phases. Phase filters select their recorded time
windows, while workload metrics retain their own phase labels. Older runs with
phase-labelled targets remain readable. Workload phase counters begin at zero
and are available before traffic starts. Real missing samples still appear as
gaps and affect measurement quality; the platform does not interpolate them.
Queue lists every nonterminal run, including queued, active, and blocked work.
Start eligible work validates the inputs saved when the experiment was submitted.
After correcting a blocked input, use Start eligible work again to retry it.

Grafana is embedded through a constrained dashboard context with only approved
experiment, run, and phase variables. When Grafana is unavailable, stored
summaries and history remain the source of retained evidence.

The current UI scope is English-only. Formal WCAG conformance and additional
localization are outside this feature.
