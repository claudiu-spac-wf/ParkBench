# Readable database observer validation — feature 017

Current result (2026-10-01): **62/62 tasks complete**. Build and 99 targeted regressions passed; native frozen/lifecycle checks, real rename, four overhead pairs and full licensed 12.8.11 baseline/variant smoke passed. Full smoke used an owned 100 ms cAdvisor capture / 5-second scrape profile; the existing 1-second platform's resource-edge gaps and unsupplied patches remain explicit limits. The sections below preserve earlier implementation history and the final qualified evidence.

## Initial baseline and prerequisites (historical)

- Implementation repository: `/mnt/d/Projects/PUG/ParkBench`.
- Planning: `/mnt/d/Projects/PUG/ParkBenchPlanningMetrics/specs/017-refactor-db-observer`.
- ParkBench HEAD: `0fc936061bf9cde3b9b3f12709a1314bfdd0414d` (matches the specification).
- Original observer SHA-256: `b670c801085101207834ba55d090dc731082e19587347de2c4bbb4d86e812bbc` (matches the specification; retained unchanged).
- Frozen catalog SHA-256: `f14501b76ae212219821a3c95488aec6432f9fb4b9366db269a431bc483ce583` (81 definitions).
- Node: v24.20.0. Installed workspace dependencies and dist exist; build verification is pending.
- Docker daemon is reachable. Native license/compiler/image configuration is present; file/image availability and licensed execution remain unverified.
- Existing git/Docker/ESLint/Prettier ignore files cover applicable generated outputs, dependencies and private configuration. Docker intentionally includes dist for runtime packaging. npm publishing is disabled (`private: true`).
- No project AGENTS.md instructions were found in the repositories or ancestor directories.

## Pre-existing changes

Preserve all of the following; overlapping feature edits must retain the existing content. Private configuration is neither reproduced here nor automatically rewritten.

```text
 M apps/control-plane/src/api/control-ui-routes.ts
 M apps/control-plane/src/comparisons/service.ts
 M apps/control-plane/src/control-ui/service.ts
 M apps/control-plane/src/runs/coordinator.ts
 M apps/control-plane/src/runs/evidence.ts
 M apps/control-plane/src/runs/run-error.ts
 M apps/control-plane/src/scenarios/builtins.ts
 M apps/loadgen/src/runner.ts
 M apps/web/src/features/comparison/ComparisonPage.tsx
 M apps/web/src/features/experiments/MatrixExperimentPage.tsx
 M apps/web/src/features/history/HistoryPage.tsx
 M apps/web/src/features/runs/QueueDashboardPage.tsx
 M docker/observer/Dockerfile
 M docs/control-ui.md
 M docs/operator-runbook.md
 M docs/scenario-authoring.md
 M docs/security-boundaries.md
 M docs/workload-authoring.md
 M openedge/workloads/README.md
 M package-lock.json
 M packages/compose-runner/src/orchestrator.ts
 M packages/compose-runner/src/parameters.ts
 M packages/compose-runner/src/run-compose.ts
 M packages/contracts/src/allowed-parameters.ts
 M packages/contracts/src/artifacts.ts
 M packages/contracts/src/control-ui.ts
 M packages/contracts/src/index.ts
 M packages/contracts/src/openedge-validation.ts
 M packages/contracts/src/run-evidence.ts
 M packages/contracts/src/run.ts
 M packages/contracts/src/scenario.ts
 M packages/contracts/src/schemas/scenario-v2.schema.json
 M packages/contracts/src/schemas/ui-options-v1.schema.json
 M packages/contracts/src/validator.ts
 M packages/contracts/src/workload-contract.ts
 M tests/contract/matrix-expansion-v1.test.ts
 M tests/contract/openedge-compose.test.ts
 M tests/contract/ui-options.test.ts
 M tests/unit/work-scenario-validation.test.ts
 M tests/unit/workload-contract.test.ts
?? apps/loadgen/src/template-values.ts
?? apps/observer/src/latency/
?? apps/web/src/shared/latency.ts
?? examples/scenarios/parkbench-read-mix.json
?? openedge/workloads/Workloads/Generic/
?? packages/contracts/src/database-latency.ts
?? packages/contracts/src/run-parameters.ts
?? tests/browser/database-latency.spec.ts
?? tests/contract/arbitrary-reads-workload.test.ts
?? tests/contract/parkbench-read-mix.test.ts
?? tests/integration/database-latency-fake.test.ts
?? tests/unit/database-latency-apply.test.ts
?? tests/unit/run-parameters-latency.test.ts
?? tests/unit/template-values.test.ts
```

## Initial validation status (historical)

Implementation and native acceptance are pending. A probe, fixture, or skipped check does not count as native patch support. Required gates: standalone probe T009, completed bindings/semantic comments T029, equivalence/essential metadata T046, defaults T047, metadata lifecycle T052/T054, final review/performance/patch/smoke T058–T062.

## Setup verification

- T003: `npm run build` passed on retry using installed workspace dependencies and Node v24.20.0. The first attempt ended with a transient ENOENT/process.cwd error; a fresh working directory resolved it. No lockfile was overwritten.
- Available local images include parkbench/openedge-db:dev and Progress 12.8.11 base images. Availability alone does not establish native compilation or runtime support.

## User refinement during implementation

The user requested explicitly declared required metadata fields instead of LIKE/full-column copies. Production caches now retain all accessible rows but only table number/name/type/original RECID and index number/name/original owner RECID. Planning artifacts and acceptance cases were updated together. Test-only VST fixtures may inherit native fields to preserve the raw leading-underscore names ABL rejects in ordinary explicit field declarations.

## T009 standalone native binding probe

- Passed in an owned disposable `parkbench/openedge-observer:dev` container using its licensed AVM; container and local owned staging cleaned afterward.
- Dynamic/static sentinel values both 917; full parameter binding returned `probe-parameter`; original owner resolved to `FixtureOwner`; copied identity differed and original owner identity was retained.
- Initial probe failures exposed ABL underscore-field declaration restrictions, protected native LIKE declarations during transformation, character-only PUT emission, and the need to RELEASE created temp-table rows before another buffer reads them. All were corrected before marking this task complete.
- This proves only standalone transformation/binding mechanics; completed collector bindings, equivalence, and patch support remain separate gates.

```json
{
  "image": "parkbench/openedge-observer:dev",
  "probe": {
    "dynamicSentinel": 917,
    "staticSentinel": 917,
    "parameterSentinel": "probe-parameter",
    "tableName": "FixtureOwner",
    "originalOwnerPreserved": true,
    "copiedIdentityDiffers": true
  }
}
```

## Completed collector gate (T029)

- Native 12.8.11.0.1274 compiled and ran the completed collector in both modes. Normal output remains protocol 3 with all 14 sources; live parameter capture returned 148 rows and contract v1.
- Completed original/v2 native fixture bindings produced equal parsed results in both modes, with 70 table labels, exactly 256 sorted index labels and nine full parameter rows. Assertions inspect every required metadata value and original owner identity, with copied RECIDs forced to differ.
- Reviewed all 104 selected field comments and six support fields against the authoritative references in the planning field inventory and existing adapter mappings. Each owning procedure explains its fields. Special caveats remain explicit: buffer-lock waits in Summary-DbAccesses, exclusive-find releases, all-process versus APW writes, database uptime, latch microseconds, BI write operations and ambiguous raw checkpoint/BI size units. No metric mapping changed.
- Fixed native compilation findings before this gate: capability references require `{&PB_HAS_*}` and static OPEN QUERY requires block error handling rather than NO-ERROR. Test fixture RECID branches use separate assignments.
- Full differential boundary, packaging, activation and lifecycle gates remain pending. Test-only VST LIKE declarations preserve the supplied native schema; production metadata tables use seven explicit fields.

## Native differential and lifecycle acceptance

- T030/T046 differential suite passed on the supplied 12.8.11 runtime (55.4 seconds including disposable database/container setup and many separately compiled cases). All 14 present-empty/absent cases, numeric/character unknowns, optional fields, pool/checkpoint order, status failure and both contracts matched the immutable original. Actual output passed existing consumers.
- Full capture checks passed: empty complete capture, absent source, missing/empty/128-byte/129-byte names, missing flags/value/type metadata, 8,192/8,193-byte values, reason overwrite, 1,025 input rows, estimated 2 MB response stopping and output beyond 30,000 characters. The 65,536-byte guard is retained verbatim; the supplied native CHARACTER value ceiling prevents a larger single-value fixture, so that guard has structural rather than native boundary evidence.
- Cache lifecycle checks passed: every required row/value and original owner identity; copied RECIDs differ; empty inventory; post-startup source metadata mutation leaves cached labels/metrics fixed; a subsequent invocation observes renamed table/index metadata; injected partial-copy failure returns the stable error before both modes.
- Raw preparation passed normal/capture, two concurrent invocations against separate owned databases, compile failure without stale fallback, and private source/r-code cleanup. Build compiler preparation generated fresh v2 r-code and removed its private directory.
- Fresh generic observer image: `parkbench/openedge-observer:feature017-validation`, image ID `sha256:7b1e148146d219c90454e8d57b38507da42b6723980bd9db8369a19a4018d718`, collector SHA `c5d6d6bae58c03433e28f143da78e04ac0e59728769919bdbb71e78415888e9b`; exact v2 artifact label verified. Final reuse now verifies both procedure and source identity.
- Real-schema default-image acceptance passed: 70 tables, 350 indexes, exact first 256 sorted labels, Table0069 with 100 creates, all table series retained and no invented `other` table. Owned native container/database cleanup completed.
- Contract suite initial run: 50/52 passed; two old source/compile-string assertions were corrected to v2/error-handled compilation and all 19 image-build contract tests then passed. A broader consumer suite initially passed 41/42; its remaining canonical-path assertion was updated without relaxing the detailed-lock polling restriction. Final rerun remains pending.
- All licensed inputs and the compile seed passed `openedge:preflight --image-stage all`. Fresh all-stage build is in progress under an isolated tag/output root; no private operator configuration has been rewritten.

## Final implementation handoff — user-requested stop

- Fresh all-stage licensed build completed successfully, including generic and final images. Raw observer image also built successfully. Generated compiled default is `/app/openedge/observers/db/parkbench-db-observer-v2.r`; raw default is `/app/openedge/observers/db/prepare-run-db-observer.p`. Both actual packaged defaults passed normal and parameter modes without a procedure-selection override. The raw image was exercised with the already supplied licensed runtime in an isolated derived validation image.
- Compiled-default fixture initially used a different logical database name and failed `Database parkbench not connected`; matching the build's logical name through a fixture alias resolved it. Both compiled modes then passed (1,142/1,081 ms including Docker staging/process startup). Raw default passed at 905/663 ms with cleanup. These are invocation wall times, not paired overhead or CPU/memory measurements.
- The real compiler adapter rejected deliberately invalid source, removed stale named r-code and cleaned its owned driver/profile files.
- Final targeted regression rerun: **93 tests passed, zero failed, zero skipped**. Native differential and lifecycle/concurrency suites separately passed. Fresh real-schema image acceptance preserved 70 tables, 350 indexes, exact first 256 labels and 100 creates on Table0069.
- Standard licensed baseline/variant smoke and paired-overhead commands were both attempted using a private temporary configuration and fresh generated images. Both failed before workload submission: the existing CLI posts to an experiment API now returning `operation_retired` (`Use the disk-scenario preview and submit API`). No benchmark results or overhead measurements are claimed. This existing workflow issue was not changed as part of the collector refactor.
- Real-database rename acceptance is still pending; freshness was proved through native fixture bindings. All other patch versions without supplied compiler/runtime inputs remain unverified. The tested runtime is 12.8.11.0.1274.
- Final audit confirms original SHA `b670c801085101207834ba55d090dc731082e19587347de2c4bbb4d86e812bbc`, catalog SHA `f14501b76ae212219821a3c95488aec6432f9fb4b9366db269a431bc483ce583`, and v2 SHA `c5d6d6bae58c03433e28f143da78e04ac0e59728769919bdbb71e78415888e9b`. No concurrent changes were detected on feature-applied files. New source/tests pass the scoped whitespace check. Existing CRLF format was preserved on eight edited files.
- 58/62 tasks are checked. T054, T059, T060, and T061 retain their remaining native acceptance gaps in the planning task list. T062's audit/report is complete; this does not claim all outstanding acceptance work passed.
- User requested stopping after current work because the machine needs to shut down. No new long validation work was started after that instruction. No owned validation containers remain. Existing platform and unrelated feature containers were left running. No extension hooks file exists, so post-implementation hooks are inapplicable.

Durable nonsecret evidence: `.parkbench/openedge/readable-db-observer/feature017-validation-summary.json`, `feature017-build-manifest.json`, and `feature017-generic-manifest.json`. Fresh test image tags are `parkbench/openedge-observer:feature017-validation`, `parkbench/observer:feature017-validation` and the isolated raw-runtime validation image. Private `.env.local` was not rewritten.

## Resumed validation — 2026-10-01, Linux workspace

- Reconciled the migrated implementation at `/home/claudius/projects/PUG/ParkBench`; HEAD and original/v2/catalog SHA-256 still match the handoff. Node is v24.21.0. The available `parkbench/openedge-observer:dev` image advertises the exact matching v2 SHA and compiled default; the former feature017-validation tag was not migrated.
- T054 passed its remaining real connected-database case: loaded incremental schema definitions to rename Table0000 and Index0000 between independent collector invocations, and verified refreshed table/index labels and metric ownership. All 70 application tables, exactly 256 selected index labels, and the busy table's 100 creates remain correct. Native acceptance: 1 passed, zero failed/skipped (8.4 seconds). Complete before/after payloads are retained in `.parkbench/openedge/readable-db-observer/connected-metadata-rename.json`.
- Build passed after adding an explicit protocol assertion to narrow the test payload type. The first native attempt could not find the old validation image tag; the matching current dev image passed.

## Completed overhead validation (T059)

Four serial observer-off/on pairs passed on the supplied 12.8.11.0.1274 runtime. Each pair used identical seed, scenario, images, load seed (2026), and effective parameters except `database.metricsEnabled`; retained context/summary and rendered Compose files were checked. All eight runs succeeded, retained captured parameters, had zero workload errors/timeouts, complete summaries, and complete owned cleanup. The small seed emits 34 table/201 index labels; the validation-only large copy adds 70 tables/350 indexes and emits 104 table/256 index labels. Original seed files were not modified.

| Mode / inventory | Paired IDs (off / on) | Measurement seconds | CPU core-seconds (off / on) | Peak MiB (off / on) | Requests/sec (off / on) | Latency p95 ms (off / on) |
|---|---|---:|---:|---:|---:|---:|
| compiled / small | parkbench-bank-mix-42d4 / parkbench-bank-mix-cec5 | 30.25 | 0.0036 / 3.0575 | 171.8 / 463.1 | 491.40 / 505.88 | 4.751 / 4.826 |
| compiled / large | parkbench-bank-mix-b942 / parkbench-bank-mix-67c8 | 30.25 | 0.0032 / 3.2137 | 172.4 / 510.4 | 497.41 / 505.29 | 4.811 / 4.906 |
| raw / small | parkbench-bank-mix-bbcb / parkbench-bank-mix-70c7 | 60.27 | 0.0265 / 6.9009 | 163.7 / 451.1 | 505.29 / 489.24 | 4.806 / 5.032 |
| raw / large | parkbench-bank-mix-ca0a / parkbench-bank-mix-cffd | 60.25 | 0.0328 / 7.1891 | 171.7 / 443.3 | 500.43 / 492.94 | 4.837 / 4.953 |

CPU is the cumulative counter delta between retained measurement scrapes; peak memory is the maximum of retained working-set/usage samples. These are single paired observations, without an arbitrary percentage ceiling or a statistical regression claim. Compiled pairs measured 30 seconds; raw pairs used 60 seconds after one short compiled attempt missed a required resource scrape. Compare off/on within each pair; the windows differ across modes.

The existing `parkbench_observer_collection_duration_seconds` telemetry measures cached metrics endpoint responses, not full AVM execution. Observer-on response means/p95 were respectively 6.82/7.75 ms (compiled small), 10.16/12.46 ms (compiled large), 9.10/16.21 ms (raw small), and 8.31/10.10 ms (raw large). Full native command durations were measured separately against disposable connected copies of the same seeds, through each packaged default launcher without a normal procedure override. They include Docker exec, AVM startup, metadata copying, JSON serialization, and raw preparation. Each profile ran three normal calls and one complete capture:

| Mode / inventory | Maximum normal seconds | Capture seconds | Result |
|---|---:|---:|---|
| compiled / small | 2.783 | 1.062 | PASS |
| raw / small | 1.070 | 1.062 | PASS |
| compiled / large | 2.791 | 1.062 | PASS |
| raw / large | 1.073 | 1.064 | PASS |

Normal calls stayed below the unchanged 5-second timeout and captures below 10 seconds. Each actual native payload reported 12.8.11.0.1274 and all 14 source capabilities present. Native timing containers/databases were removed. Paired startup capture telemetry also stayed below 10 seconds.

The smoke workflow was repaired for the current architecture: validated coordinator submission replaces the retired endpoint; current run-context/summary contracts replace legacy evidence reads; the Prometheus client forwards raw queries and target readiness; an isolated standalone proxy supplies owned cAdvisor metrics. The existing native endpoint kind now identifies DB duration telemetry after Prometheus assigns its service label. Six focused tests passed (overhead, standalone fake CLI, target discovery), zero failures/skips. Fake smoke does not establish native completeness.

The initial raw attempt accidentally reselected compiled defaults because generated `images.env` takes precedence. An isolated generated image environment now selects the derived raw-bootstrap image. Its first corrected attempt used an incorrect runtime user; matching the compiled base user fixed startup. These unsuccessful attempts are retained as diagnostics and are excluded from successful evidence. The raw image changes only the packaged launcher/default/bootstrap and its procedure label; Node, licensed runtime and observer application match the compiled base. Private `.env.local` was not rewritten.

Durable nonsecret evidence: `.parkbench/openedge/readable-db-observer/paired-observer-overhead.json`, `native-command-timings.json`, `native-command-timings.cjs`, `stage-raw-overhead.cjs`, `raw-overhead-manifest.json`, and the four referenced paired artifacts under `.parkbench/artifacts/observer-overhead/`.

## Standard smoke reconciliation

The first resumed standard 300-second baseline/variant attempt finished both workloads and owned cleanup. The variant succeeded. The baseline was correctly classified INCOMPLETE because the first static cAdvisor sample for node-exporter arrived 5.285 seconds after measurement start, beyond the unchanged five-second edge allowance; platform CPU/memory coverage was therefore partial. There was no internal sample-gap reason. The CLI had waited for the separate run-labelled cAdvisor job while current platform summaries read the static job. Full diagnostics are in `platform-smoke-edge-diagnostic.json`.

The standalone smoke client now waits for a fresh successful static cAdvisor scrape and places the phase start halfway through that scrape interval. No collector timeout, source cadence, summary coverage rule, native procedure or metric mapping changed. Ten focused tests passed, zero failures/skips, including stale readiness, bounded failure, ordinary target readiness, fake CLI and overhead evidence. Scoped lint passed. The orchestration timeout also accounts for both serial variants' phase lengths instead of expiring after ten minutes. That retry remained incomplete on a PAS resource edge; the workaround was subsequently removed. The completed acceptance and monitoring qualification are recorded below.

## Supplied native patch acceptance (T060)

The original standard banking scenario (30-second warmup, 300-second measurement, 30-second cooldown) passed through the compiled CLI's baseline and `-B=10000` variant on an owned validation monitoring profile. Both runs SUCCEEDED with complete native/resource coverage, zero workload errors/timeouts, retained complete parameter snapshots, correctly interpreted native measurement rows, and complete run-owned cleanup. The variant snapshot's `-B` verification matched 10000. Run IDs: **parkbench-bank-mix-1691** (baseline) and **parkbench-bank-mix-8289** (variant). Native live suite: 1 passed, zero failed; its additional-patch case was skipped because no other profiles were supplied.

The actual collector reported database build **12.8.11.0.1274**; the installed client release banner is **OpenEdge Release 12.8.11 as of Thu Feb 12 10:25:54 EST 2026**. The frozen fixture/native bootstrap tests compile and execute with the matching licensed dev observer's AVM. All 14 source-presence capabilities are true on the supplied schema (the corresponding PB_HAS_* flags are 1); optional columns remain checked by bound handles. Current dev manifest records the fresh all-stage final build, configured 12.8.11 inputs, and protocol 3/all_tables/capture.v1. Packaged v2 .p matches the retained source SHA; compiled r-code SHA is `d875887af907e5e3327bebf0cb45e46b91a8575e43af15feddcef2081ec7ade5`. Image IDs and source/procedure labels are retained in `current-image-identities.json`. Nominal 12.8.0–12.8.9 and 12.8.12 remain **unverified / not supplied**; synthetic compatibility fixtures are not native patch evidence.

Monitoring qualification: the existing platform's 1-second cAdvisor housekeeping produced intermittent native-timestamp edge gaps in two full-duration trials and one 60-second trial; those failed/incomplete trials are not benchmark success. A phase-placement workaround was investigated and removed when it did not resolve both publishers. Final production smoke retains ordinary target readiness and the original summary rules. The passing full-duration acceptance uses disposable cAdvisor/Prometheus containers, **100 ms cAdvisor housekeeping and unchanged 5-second Prometheus scraping**, preserving original source timestamps and the existing 5/10-second collector limits. The user's running platform and private config were not changed. Its 1-second profile's resource-edge limitation remains outside the collector acceptance result.

The validation stack and its temporary data holder/volume were cleaned up. Its TSDB is archived under `.parkbench/openedge/readable-db-observer/isolated-monitoring/prometheus-data/`; the profile, generated configuration, logs and runner remain alongside it. The cached summaries, `standard-smoke-results.json`, `current-packaged-observer-hashes.json`, `client-release-validation.json`, and `.parkbench/openedge/live-compatibility-results.json` preserve nonsecret acceptance evidence.

## Feature017 final acceptance and audit (historical T061–T062)

All **62/62 implementation tasks** are now fulfilled and checked. Final build, scoped lint, scoped formatting and whitespace checks passed. The quickstart contracts/consumer/security suite plus smoke, overhead and target-readiness regressions passed **99/99**, zero failures/skips. The current licensed dev-image native rerun passed all **3/3** frozen-equivalence, metadata lifecycle, concurrent raw preparation and stale-compilation checks (22.2 seconds), zero failures/skips. The connected real-database rename/all-table acceptance separately passed. Full-duration standard live acceptance passed both variants with the qualified owned monitoring profile above; its one unsupplied additional-patch case remains skipped, not passed.

The final source/catalog audit still matches original SHA `b670c801085101207834ba55d090dc731082e19587347de2c4bbb4d86e812bbc`, v2 SHA `c5d6d6bae58c03433e28f143da78e04ac0e59728769919bdbb71e78415888e9b`, and catalog SHA `f14501b76ae212219821a3c95488aec6432f9fb4b9366db269a431bc483ce583`. There were no later ABL changes after the completed 104-field/six-support-field semantic review; all 14 dedicated procedures and required metadata projections remain covered. Consumer versions and all 81 catalog definitions are unchanged. Existing unrelated migration changes were preserved; no commit or private config rewrite was performed.

Success criteria: SC-001 frozen both-mode output equivalence passed; SC-002 normal/capture consumers and catalog acceptance passed; SC-003 all 14 source procedures remain independently readable; SC-004 complete startup metadata/original ownership, 70-table/350-index limits, cache lifecycle and real rename passed; SC-005 unavailable/optional/unknown/bounds/error/compile-failure outcomes passed, subject to the documented native CHARACTER boundary limit; SC-006 compiled/raw packaged defaults and both read-only modes passed, including licensed baseline/variant workflow on the specified monitoring profile; SC-007 all selected metric/support field comments retain their completed semantic review and structural checks.

Remaining external validation limits are explicit: no native inputs were supplied for the other nominal patches, the 65,536-byte single CHARACTER-value guard has structural rather than native boundary evidence, and the existing 1-second housekeeping platform can classify resource coverage incomplete at measurement edges. The source refactor does not relax that coverage policy. All owned native fixtures, validation monitoring containers/holder/volume, and benchmark resources were cleaned up. Only the pre-existing platform containers remain running. No `.specify/extensions.yml` exists in the planning repository, so no post-implementation hooks apply.

Final logs are retained in the ignored evidence directory as `final-build.log`, `final-regressions.log`, `final-native-regressions.log`, `full-live-smoke-qualified.log` and `scoped-lint.log`. The final machine-readable handoff is `feature017-validation-summary.json`.

## Effective buffer allocation

The collector additionally reads `_BuffStatus._BfStatus-TotBufs` through a static,
optional schema binding. OpenEdge 12.8.11 on the reference seed allocates two
reserved primary buffers beyond `-B`: native `-B=3000 -B2=100` reports 3102 total,
3002 primary active at saturation and zero alternate active. Effective primary
capacity is the observed total minus current `-B2`; alternate capacity remains
`-B2`. Free capacity is effective capacity minus active occupancy. This preserves
nonnegative capacity checks without clamping occupancy or inventing missing
samples. Missing allocation evidence uses the existing `-B`/`-B2` checks;
conflicting totals or occupancy above the verified allocation are unavailable.
The aggregate `_ActBuffer` row remains excluded.

Rate charts use a lookback of at least four native refresh intervals, independently
of Grafana's plotting grid. A one-second grid does not imply one-second collection.
Real missing observations, phase restrictions and independent counter epochs
remain gaps. Table writes with complete, zero-valued counters retain one zero
`Other` display row when there are no active tables.

Completed-run evidence is retained under
`.parkbench/validation/feature019/completed-run-gaps/`. The original run's missing
active/free samples are not backfilled. Its table/index counters remain unchanged;
the repaired rate queries render them continuously during measurement/cooldown.


## Current benchmark-readiness acceptance

The earlier feature017 audit describes the source/catalog at that time. Feature019
adds optional allocation evidence and explicitly corrects the three cache metadata
entries; the original frozen baseline stays intact. Metric suffixes, types, units
and dimensions remain compatible, with the previously added raw free-list metric
kept distinct. Old source declarations remain accepted when `_BuffStatus` is absent.

The completed reference read run `parkbench-read-mix-1-af17` retained 32 continuous
active/free observations through 30/120/10-second phases. Its maximum native gap
was 5.097 seconds at a five-second cadence. The filled primary cache had 3002
active/allocated buffers and zero free capacity. Real Grafana12.1.1 rendered its
capacity, active, free and cumulative-hit charts with one true primary identity;
the recovery dashboard's sampled series likewise had one database identity.
Evidence: `.parkbench/validation/feature019/us4-grafana.json` and the standalone
scenario's `result.json`/screenshots beneath the native scenario acceptance root.

Run Summary has eight DB table/index read/write panels. Index units are genuine
database-wide blocks/s and blocks from `_ActIOType`; they are not per-index
attributions. The retired saved-result rows are removed from Grafana while saved
summary/context artifacts remain available in History and comparison workflows.
`Database BI & APW data` and `Database transactions, locks, and latches` retain
their stable dashboard UIDs and old-link routing. Real retained-Grafana migration
and all 18 dashboard/comparison browser workflows passed.

Chart legends are right-side tables sorted by descending Mean. Plot/field ordering
also uses descending finite means, stable canonical identities on ties and
unavailable values last. Stock Grafana12.1.1 forces bottom placement below its
992px body breakpoint. The platform starts Grafana with a temporary static root
that adds the owned `deploy/grafana/frontend/chart-layout.css`: Grafana views have
a 992px minimum width established before chart mounting, with horizontal scrolling
on narrow screens. The upstream image and JavaScript bundles are unchanged.
Desktop1440px and narrow760px rendering, descending values, exact ties and missing
values passed against real Grafana; evidence is feature019/us6-grafana.json.
Run the real Grafana fixture on upgrades to verify the breakpoint/layout contract. Text notices identify their last
successfully checked runs and range; refresh failures explicitly invalidate the
notice rather than silently applying a prior scope to the current selection.

New run IDs include the display number (`name-number-random`). Comparison selection
supports multiple experiments and an exact run basket, including saved selections.
Different scenarios produce a warning; seed/calibration/workload differences do
not prevent production comparisons. Archived run IDs and saved evidence are intact.


### Fresh native timestamps on every metric scrape

A sequential mixed acceptance run exposed one 10.026-second native interval while
all five-second Prometheus scrapes succeeded. Independent cache-refresh and scrape
timers could replay the same explicit timestamp and miss an intervening snapshot.
Metric requests now collect fresh native evidence, retaining the collector's actual
capture timestamp. Health probes reuse recent evidence and all concurrent requests
share one in-flight native collection. A failed fresh scrape returns HTTP503;
it never replays a previously healthy observation as a fresh sample.

The original completed run's missing active/free samples cannot be recovered:
its old collector marked the saturated primary pool unavailable when occupancy
included two reserved primary buffers above configured -B. Corrected allocation
comes from same-snapshot _BuffStatus total minus alternate capacity; historical
snapshots without allocation evidence retain strict fallback/conflict handling.
The corrected dashboard rate windows work for retained table/index counters,
but do not invent occupancy samples or bridge actual collection failures.

Final native closeout2026-10-02: all four read-bearing presets SUCCEEDED with
complete required resource coverage and cleanup. The clean70/30 retry
`parkbench-read-write-70-30-1-5d1c` completed1068 reads and499 writes with0 operation
errors and a5.040s maximum native interval. Native identities have one authoritative
publisher; every owned seed-copy volume was removed and the source remained
unchanged. Optional insufficient-data warnings remain truthful. The earlier70/30
INCOMPLETE result from a Grafana restart is retained without modifying its quality.
Reports: feature019/benchmark-scenarios.json, benchmark-scenarios-70-30-rerun.json,
and completed-run-gaps/final-native-audit.json.
