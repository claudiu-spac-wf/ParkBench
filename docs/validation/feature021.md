# Feature 021: Run controls and named latch metrics

Implementation starts from commit `aa2fed71c43d931c9061cb5f82c585c104e6c413` plus the operator's existing working changes. Those changes are preserved, with a local backup at `/tmp/parkbench-feature021-baseline-hwri2ej9`.

## Environment and acceptance

Observed on 2026-10-03: Node 24.21.0, npm 11.19.0, Docker client 29.8.2/server 29.8.0, Compose 5.5.1. `npm run openedge:preflight` passes with local licensed inputs, imported DB/PAS/JDK images, executable compiler adapter, and a usable selected seed. Target: OpenEdge 12.8.11. Enterprise/background writer capability must be explicitly configured and verified natively; image names are not licensing evidence.

The existing Git/Docker/Prettier/ESLint ignore configuration protects dependencies, generated builds, runtime evidence, logs, environment files and private OpenEdge inputs. This application is private and is not published as an npm package.

Fixture validation uses `npm run typecheck`, `npm run build:web`, `npm run test:unit`, `npm run test:contract`, `npm run test:integration`, `npm run test:browser`, `npm run smoke:fake`, and dashboard build/check. Licensed acceptance uses `PARKBENCH_RUN_OPENEDGE_TESTS=1`; rendered dashboard acceptance uses `PARKBENCH_RUN_GRAFANA_INTEGRATION=1`. Never count a skipped licensed/rendered test as acceptance.

Evidence is local under `.parkbench/validation/feature021/p1/` and, after the P1 gate passes, `.parkbench/validation/feature021/p3/`. Keep license contents, credentials, source data and raw per-run time-series exports out of evidence and committed fixtures. Prometheus retains time series; record bounded queries and windows instead.

## Progress

Setup and US1 implementation/tests T001–T024 are complete. US1/US2 reconciliation through T047 and the combined P1 gate T048 are verified. Comparison/preset work T049–T070 is verified. Full catalog work T071–T093 is in progress. Both P1 stories, their failure paths, and actual Grafana/native acceptance must pass before comparison/preset/catalog implementation begins. Run quality warnings remain distinct from measurement failure: the later comparison change does not turn failed runs into successful ones.


## US1 evidence so far

Focused run-control contracts, normalization, immutable replay, owned shell lifecycle, coordinator readiness/cancellation, active measurement writer loss and native log retention: 21 tests pass. The control-plane build, typecheck and web build pass. Browser fixed/sweep journeys pass (2 tests, including a 16-cell sweep across all four controls). Evidence: `.parkbench/validation/feature021/p1/run-controls-fixtures.log`.

The rebuilt licensed DB image passes `PARKBENCH_RUN_OPENEDGE_TESTS=1 node scripts/run-with-env.mjs node --import tsx --test tests/integration/openedge-run-controls-live.test.ts` (165.8 seconds). Captured native evidence: `.parkbench/validation/feature021/p1/native-controls/acceptance.json` and corresponding bounded native/preparation logs. It covers APW 0/2/9, BIW false/true, inherited 512 KiB, explicit 16/512/16384/262128 KiB, buffers 64, same-run restart without a repeated truncate, planned shutdown, insufficient explicit connection capacity, startup mismatch, offline preparation failure and active owned writer loss. Every run mounts the controlled source read-only; source file sizes, modification times and permissions remain unchanged. Only fixture-created labeled containers/volumes are removed.

OpenEdge 12.8.11 raises requested `-bibufs 3` to an observed 20. The documented minimum stays 3; the native mismatch fails readiness and retains expected/observed evidence instead of silently changing the requested setting. The same acceptance suite proves this negative boundary case. This finding does not certify 3 as an exact applied native value.

Broader fixture checks found seven pre-existing mismatches between edited scenario files and old test/generator expectations. Two additional regressions from new environment fields and DB run labels were corrected. A full integration run passed 268 cases, skipped 28 gated cases, and failed one new test's terminal-phase assertion; that assertion now checks the retained measurement boundary, and the focused test passes. At that checkpoint, build/regression reconciliation and authored smoke were still pending; later checkpoints below record the completed acceptance.


US1 broad rechecks now pass: 298 unit, 342 contract, 269 integration (28 licensed/rendered gates skipped), all 75 browser cases across the main run and focused rechecks, and 19 security tests. Fake smoke and preflight pass. `run-controls-fixtures.md` records exact commands and evidence. The authored native smoke initially lacked running configured Prometheus/cAdvisor services; those existing services were started and the smoke retried without disabling required sources.

Docker Desktop twice exhausted host memory with its 24 GiB VM on the 30 GiB host. For acceptance only, `MemoryMiB` in its settings was changed to 16384; the previous value is retained in `/tmp/parkbench-feature021-docker-memory.json` and was restored to 24576 after validation finished. This is an environment workaround, not a production ParkBench configuration change. Native fixture results preceding the limit and subsequent authored smoke record their actual environment separately.

The operator approved updating the seven stale scenario checks to their existing authored timings, operation mixes, and load levels. Scenario JSON was preserved. Browser checks were also aligned with the existing feature 020 candidate/baseline selection and lazy detail loading.

The authored native smoke exposed Docker Desktop's stale individual file mounts: the load generator saw an empty workload start marker and a truncated phase clock after their host-side updates. The first run failed with missing workload metrics and `loadgen did not exit after cooldown`; the second was cancelled through its owning controller and cleaned up. Mutable workload hand-off files now share a dedicated run-owned `runtime` directory, with validated paths; summary evidence is consolidated before the transient files are removed. A live directory-mount check proved both host-to-container release and container-to-host summary publication. Related Compose, load generator, lifecycle, finalizer, retained evidence and summary-publication checks pass (57 tests). The subsequent native smoke outcome is recorded below.

US2 requested tests T028–T030 are authored before implementation. The v4 protocol/inventory, named arithmetic/filter, and required-source/finalization tests reject the current missing behavior (15 cases: 11 expected failures, 4 existing compatibility/guard passes). Evidence: `.parkbench/validation/feature021/p1/named-latches-red.log`. These are test-authoring completions only; the named collector, retained-query coverage, failure behavior and Grafana acceptance are not yet implemented or accepted.

The directory-mount authored run `parkbench-banking-writes-1-1c6c` completed 60/300/30 seconds with 237755 measurement requests, all required retained sources available, matched native database controls, and complete owned cleanup. Its state is `THRESHOLD_FAILED` (1457 application errors, no timeouts), rather than a missing-metrics/infrastructure failure. A bounded probe of the owned PAS returned `table_write_conflict:selected_lock`; the existing generated update implementation uses `EXCLUSIVE-LOCK, NO-WAIT` and explicitly rejects selected lock contention. The authored scenario and its status checks were not weakened. Its second variant was cancelled through the owning controller, with normal cleanup. A separate local acceptance scenario preserves the operation definitions while using one worker and 10/30/5 seconds, explicit APW=2/BIW=true/cluster=16 MiB/-bibufs=64, and explicitly declared native-proved Enterprise capability. This fixture is for configuration acceptance, not representative performance measurement. Authored smoke's unsuccessful process result remains recorded as such.


US1 acceptance is verified (T026/T027). The real production-platform UI sweep passes in 3.2 minutes: APW 0/2, BIW false, cluster 0.5 MiB and buffers 64, native matched evidence before measurement, SUCCEEDED results, and COMPLETE cleanup. Source metadata for all 20 selected seed files is unchanged. Together with the two successful scheduled APW=2/BIW=true/16 MiB runs and the controlled licensed boundary/failure suite, this covers FR-001–FR-005/SC-001 (fixed/sweep validation, exact values, precedence, immutable snapshots, help and comparison parameters) and FR-006–FR-009/SC-002 (owned offline preparation, readiness, native writer membership, capacity, health, restart and cleanup). Negative native cases retain expected/observed values and diagnostics. The original 25-worker workload threshold failure remains a recorded failure; it is not counted as passing configuration acceptance. Local evidence: `.parkbench/validation/feature021/p1/run-controls-native.md`, `native-ui-acceptance.log`, `native-ui/*-acceptance.json` and source before/after metadata. This checkpoint does not release T048 or any P3 task.


US2 v4 collection and failure implementation (T031–T046) now passes focused contracts and lifecycle checks. All 303 unit tests, 352 contract tests, and 277 integration tests pass (29 explicitly gated integration skips); 75 browser workflows pass with the licensed browser case skipped in the ordinary sweep and executed separately. Build/typecheck, web build, lint and managed dashboard generation/check pass. Later server-owned requirement and threshold-primary preservation cases pass focused rechecks. The old all-sources-failed terminal check now expects the specified named observer failure for newly required runs, while unrelated generic gaps and historical aggregate-only records retain their semantics.

Licensed native runs `feature021-native-controls-1-451b` and `feature021-native-controls-2-8564` pass with 34 complete native latch identities each, valid zero samples, matched count/duration availability, retained Prometheus evidence and complete cleanup. The licensed missing-tuple query injection passes the real finalizer failure/diagnostic/cleanup/publication checks without changing the original run or Prometheus data. See `.parkbench/validation/feature021/p1/named-latches-native.md` and `native-named-latches/*-acceptance.json`.

Actual Grafana 12.1.1 / Prometheus 3.5 fixture acceptance passes in `named-latches-grafana-identities.log`. Rendered multi-run panels show separate 10/30/0 nap totals, 2/5/0-second durations, and count/rate/seconds units with readable run/name/type legends. Reset and multiple-epoch cases reduce each instance/epoch before name aggregation; controller copies do not double-count. All managed aggregate latch panels have explicit aggregate titles and navigation preserving run/phase/time context. Screenshots and response frames are in `.parkbench/validation/feature021/p1/named-latches-grafana/`; a total-count screenshot was visually inspected. This covers FR-010–FR-014/SC-003. At that checkpoint the native UI recheck was pending; P3 began only after the subsequent verified T048 release.


Combined P1 gate T048 is released after the final native UI recheck passes (3.2 minutes). Both runs retain exact frozen/observed controls, protocol-4 requirements, 34 complete latch identities before measurement, SUCCEEDED results and COMPLETE cleanup. All 20 source metadata records remain unchanged. US2 checkpoint T047 is verified alongside US1 T027; FR-015/SC-004 prioritization is satisfied. Commands, versions, ordinary/gated test outcomes, actual native/Grafana evidence and ownership are reconciled in `.parkbench/validation/feature021/p1/acceptance.md`. All P3 tasks were still incomplete when this gate was verified.

## US3 accepted

T049–T070 are verified after the P1 gate. Comparison metric descriptors, read-only bounded saved/workload/named projections, explicit row paging, accessible metric/statistic/semantic-selector choices, empty/default states, and browser-local presets are implemented. The 100→120/+20% badge remains visible with orange incomplete/ineligible quality warnings in default and selected views; numeric/source guards still withhold unsupported percentages. Failed run classifications stay intact, and the fixed CSV fixture remains byte-identical.

Three-metric save/reload/reuse in a different comparison passes in 1.5–1.6 seconds. Storage denied/quota/corrupt, invalid-record isolation, unknown metrics, cross-tab revision conflicts and unrelated-record preservation pass. All eight batches and sixteen row pages of a 256-entry preset pass an actual browser check; 1200 table rows have no omissions/duplicates. Licensed retained v4 data gives 34/34 available native named totals through the projection adapter. The orange warning screenshot was visually inspected; quality warnings are consolidated per table/section. Evidence and exact chronology are in `.parkbench/validation/feature021/p3/comparison-metrics.md`, with passing build/web/lint, focused checks, 31 comparison browser workflows, ordinary unit/contract/integration suites and separate licensed acceptance. US4 and integrated verification were still pending at this checkpoint; their completed evidence follows.


## US4 accepted and integrated verification

All 162 raw reference names map to 160 audited canonical definitions, covering all 154 installed-family and 160 current-listing entries. The full searchable catalog shows purpose, exact value form, multi-user minimum/maximum/default states, units, conditions, dependencies, scope, official topic links and specific unavailable reasons. Six canonical newer switches require OpenEdge 13.0 and were rejected by the installed 12.8 executable; they remain visible with version-specific explanations. Interactive/client/utility/infrastructure switches stay visible with concrete context or ownership reasons. The previous performance allowlist is removed.

New runs use a frozen registry and literal UTF-8 token file mounted read-only. Values with spaces/quotes, enums, presence flags and explicit valued false survive preview, queueing and native startup. Controlled PF expansion enforces official UNIX syntax, source provenance, bounded recursion and source-root ownership. Conflicting duplicate editor values, invalid bounds, dependencies, paths and managed switches fail before provisioning. Retained v1 plans use an explicit compatibility adapter; new bounds never rewrite old queued snapshots. Native captures determine matches; absent/unreportable settings remain unverified with requested values and native startup logs.

Representative licensed catalog acceptance passes (three native configurations, 48.6 seconds). The post-catalog native control suite passes (165.8 seconds); the normal UI schedules two successful native runs with text/enum/false catalog settings alongside APW 0/2, BIW false, buffers 64 and 0.5 MiB clusters (3.2 minutes). Runs `feature021-native-ui-1-0b4c` and `feature021-native-ui-2-a73f` retain matched controls, complete pre-measurement named inventories and COMPLETE cleanup. Required named-latch failure/finalization and the native projection pass again using retained licensed data. Actual Grafana/Prometheus multi-run, reset, epoch and filtering checks pass again (15.6 seconds). Source metadata stays unchanged, and only owned resources are cleaned up.

Final ordinary checks pass: build/typecheck, web build, lint, dashboard generation/check, 317 unit, 363 contract, 295 integration, 20 security, one UI instrumentation case and 85 browser workflows. Thirty integration and one browser test are explicitly gated in the ordinary sweeps; required feature-native/Grafana cases were executed separately and passed. Fake smoke passes. CSV byte compatibility and historical observer protocols pass. The original authored 25-worker contention workload remains THRESHOLD_FAILED and is not represented as passing performance acceptance. Your scenario JSON edits were preserved and the seven stale regression checks updated with your authorization. Docker Desktop's temporary memory setting was restored to its original 24576 MiB, preserving all other settings.

Local evidence: [final validation](../../.parkbench/validation/feature021/final-validation.md), [complete catalog mapping/help audit](../../.parkbench/validation/feature021/p3/startup-catalog-coverage.md), [licensed catalog acceptance](../../.parkbench/validation/feature021/p3/startup-catalog-native.md), [combined P1 gate](../../.parkbench/validation/feature021/p1/acceptance.md), and [comparison acceptance](../../.parkbench/validation/feature021/p3/comparison-metrics.md). The final orange-warning screenshot was visually inspected: supported +20% badges remain displayed beside the orange quality message.

## Operator usage

In Schedule, use BI buffers, APW count, cluster size in MiB and BIW independently; use a matrix dimension to sweep a control. For example, buffers 64, APWs 2, cluster 16 MiB and BIW enabled require a verified Enterprise context and sufficient connections. Omitted cluster size inherits the copied seed. Native readiness checks exact values before measurement and preserves failures; documented `-bibufs` minimum 3 is retained in help even though installed 12.8.11 raises it to 20 and therefore fails exact-match acceptance for that request.

Open Database startup parameters to search the full catalog, inspect help, and add typed fixed values; available settings may also become matrix dimensions. A path such as `/psc/wrk/parkbench/literal spaces` is run-owned. Numeric defaults in help describe OpenEdge documentation and are not injected over seed configuration. “Not specified” is distinct from “Not applicable”; formula bounds and environment/transport limits are labeled explicitly. Missing native reports produce unverified state, never a fabricated match. New argv replaces the former whitespace startup transport; retained old metadata remains readable.

In comparisons, select metric/statistic/dimension choices and save a named preset. Presets are browser-local, survive reload, and can be applied across comparisons without changing the baseline. Replacement/deletion is explicit; storage failures leave unsaved selections usable. Quality warnings are orange and coexist with calculable differences. Missing/nonfinite values, zero baselines, mismatched semantics and unresolved source identity still prevent unsupported math. CSV downloads are unchanged. Missing required named latch evidence still fails new runs and retains diagnostics; the warning presentation never changes their recorded status.

## Requirements and governance reconciliation

Every row is verified by executed checks and retained evidence, not planning status alone.

| Requirement | Verified evidence |
|---|---|
| FR-001 | US1 fixtures, browser fixed/sweep, native frozen/observed controls; final-native-controls.log and final-native-ui.log |
| FR-002 | US1 fixtures, browser fixed/sweep, native frozen/observed controls; final-native-controls.log and final-native-ui.log |
| FR-003 | US1 fixtures, browser fixed/sweep, native frozen/observed controls; final-native-controls.log and final-native-ui.log |
| FR-004 | US1 fixtures, browser fixed/sweep, native frozen/observed controls; final-native-controls.log and final-native-ui.log |
| FR-005 | US1 fixtures, browser fixed/sweep, native frozen/observed controls; final-native-controls.log and final-native-ui.log |
| FR-006 | Native owned preparation, capacity, startup mismatch, restart, active writer loss and cleanup; p1/native-controls/acceptance.json |
| FR-007 | Native owned preparation, capacity, startup mismatch, restart, active writer loss and cleanup; p1/native-controls/acceptance.json |
| FR-008 | Native owned preparation, capacity, startup mismatch, restart, active writer loss and cleanup; p1/native-controls/acceptance.json |
| FR-009 | Native owned preparation, capacity, startup mismatch, restart, active writer loss and cleanup; p1/native-controls/acceptance.json |
| FR-010 | v4 identities and query coverage, valid zero, missing tuple failure, resets/multiple epochs and actual Grafana; final-native-named.log and final-grafana.log |
| FR-011 | v4 identities and query coverage, valid zero, missing tuple failure, resets/multiple epochs and actual Grafana; final-native-named.log and final-grafana.log |
| FR-012 | v4 identities and query coverage, valid zero, missing tuple failure, resets/multiple epochs and actual Grafana; final-native-named.log and final-grafana.log |
| FR-013 | v4 identities and query coverage, valid zero, missing tuple failure, resets/multiple epochs and actual Grafana; final-native-named.log and final-grafana.log |
| FR-014 | v4 identities and query coverage, valid zero, missing tuple failure, resets/multiple epochs and actual Grafana; final-native-named.log and final-grafana.log |
| FR-015 | Combined P1 gate p1/acceptance.md released before any P3 task |
| FR-016 | Full metric selection, browser-local preset lifecycle/storage/concurrency, source/numeric guards and unchanged CSV; p3/comparison-metrics.md and final-browser.log |
| FR-017 | Full metric selection, browser-local preset lifecycle/storage/concurrency, source/numeric guards and unchanged CSV; p3/comparison-metrics.md and final-browser.log |
| FR-018 | Full metric selection, browser-local preset lifecycle/storage/concurrency, source/numeric guards and unchanged CSV; p3/comparison-metrics.md and final-browser.log |
| FR-019 | Full metric selection, browser-local preset lifecycle/storage/concurrency, source/numeric guards and unchanged CSV; p3/comparison-metrics.md and final-browser.log |
| FR-020 | Full metric selection, browser-local preset lifecycle/storage/concurrency, source/numeric guards and unchanged CSV; p3/comparison-metrics.md and final-browser.log |
| FR-021 | Full metric selection, browser-local preset lifecycle/storage/concurrency, source/numeric guards and unchanged CSV; p3/comparison-metrics.md and final-browser.log |
| FR-022 | Complete per-topic audit, typed bounds/help, scheduling/preflight/immutable agreement, native observed/unverified and ownership; startup-catalog-coverage.md, startup-catalog-native.md and final-catalog-agreement.log |
| FR-023 | Complete per-topic audit, typed bounds/help, scheduling/preflight/immutable agreement, native observed/unverified and ownership; startup-catalog-coverage.md, startup-catalog-native.md and final-catalog-agreement.log |
| FR-024 | Complete per-topic audit, typed bounds/help, scheduling/preflight/immutable agreement, native observed/unverified and ownership; startup-catalog-coverage.md, startup-catalog-native.md and final-catalog-agreement.log |
| FR-025 | Complete per-topic audit, typed bounds/help, scheduling/preflight/immutable agreement, native observed/unverified and ownership; startup-catalog-coverage.md, startup-catalog-native.md and final-catalog-agreement.log |
| FR-026 | Complete per-topic audit, typed bounds/help, scheduling/preflight/immutable agreement, native observed/unverified and ownership; startup-catalog-coverage.md, startup-catalog-native.md and final-catalog-agreement.log |
| FR-027 | Complete per-topic audit, typed bounds/help, scheduling/preflight/immutable agreement, native observed/unverified and ownership; startup-catalog-coverage.md, startup-catalog-native.md and final-catalog-agreement.log |
| FR-028 | Orange warning plus supported +20% in default/selected views, including off-page baselines; final-browser.log and orange-warning-and-percentage.png |

| Success criterion | Executed acceptance |
|---|---|
| SC-001 | Fixed/native UI sweeps and native control boundary suite: all accepted frozen controls match before measurement. |
| SC-002 | Invalid controls/capabilities/capacity/preparation/startup/writer-loss failures preserve source state and diagnostics. |
| SC-003 | Native 34-latch inventory, exact multi-run Grafana counts/durations, reset/epoch/zero and missing-tuple finalization tests; historical status retained. |
| SC-004 | T048 verified before T049–T093, with dated combined gate evidence. |
| SC-005 | Three-metric preset reload/reuse in another comparison passes in 1.5–1.6 seconds; projected values and supported badges match. |
| SC-006 | All preset lifecycle, stale/unknown, storage denied/quota/corrupt and cross-tab conflict cases retain usable selection. |
| SC-007 | 162/162 raw entries accounted for, 160 audited definitions, all bound states/help fields and representative licensed forms pass. |
| SC-008 | 100→120/+20% and orange warning coexist in default/selected views; source/semantic/nonfinite/zero guards and failed-run status remain intact. |

Story checkpoints: US1 T027, US2 T047/T048, US3 T070 and US4 T093 are verified. All 96 implementation tasks are complete after final reconciliation. Constitution 4.0.0 principles I–V are satisfied by immutable/versioned run snapshots and owned fresh state; bounded retained Prometheus queries and required-source validation; read-only observers, faithful authored workload and protected source provisioning; explicit v1/v2/v3/v4 compatibility; and executed positive/failure-path checks with retained diagnostics. No raw full time-series exports or source content hashes were introduced. All execution remains local on the configured Docker target.

## Convergence T097–T101 (2026-10-04)

All five convergence tasks are complete. Fresh preview/submission/direct/preflight paths share scenario bounds, steps, allowed choices and dependencies. Audited aliases freeze canonically; actual duplicate/conflicting assignments remain errors. Controlled PF expansion is verified for fresh supplied manifests, supports fixed overrides and nested includes, preserves provenance and rejects missing/managed/escaping inputs before provisioning. The additive `expandedParameterFiles` field guards omission of `-pf` from native argv. Reviewed previews and queued/replayed runs retain frozen arguments without reopening source files. Flat regular PF files are accepted in seed folders; source ownership protections remain unchanged.

Dependency checking treats `-lgTruncateFrequency=0` as daily rather than disabled. Unavailable comparison choices are removed by structured index, preserving overlapping IDs and distinct statistics/selectors. Preset loading preserves structurally valid stale choices for review, and removal does not implicitly save or modify another preset. Percentage badges still coexist with orange baseline-quality warnings.

Validation evidence under `.parkbench/validation/feature021/`:

- `convergence-tests.log`: 1,001 passed, 30 explicitly gated skipped, zero failures across 1,031 tests.
- `convergence-browser.log`: 86 passed, one licensed browser test gated skipped. Includes the new overlapping-ID/same-ID stale-preset regression and existing warning/percentage scenarios.
- `convergence-lint.log`, `convergence-typecheck.log`, `convergence-web-build.log`: pass; web build retains the existing large-chunk advisory.
- `convergence-focused.log` and `convergence-followup.log`: fresh/frozen PF, narrowed broker/P1 definitions, aliases, zero dependencies and stale preset tests pass.
- `convergence-native-controls.log`: real licensed buffers/cluster/APW/BIW preparation, startup, writer-loss/failure, restart, cleanup and unchanged source checks pass (166.8 seconds).
- `convergence-native-catalog.log`: four native cases pass (64.8 seconds), including controller-flattened nested PF argv, queued > scenario > file precedence and literal text. Native parameter capture reports no mismatches and the original source metadata is unchanged. Expanded PF evidence is retained in `p3/native-catalog/acceptance.json`.

No native entrypoint/lifecycle changes, source content hashes, history rewrites or deployment commits were introduced by this convergence pass. Existing authored scenario JSON remains preserved.

Platform restart requested by the operator is complete. `scripts/start.sh --no-build --force-recreate` rebuilt the control-plane/web images from the verified compiled source and recreated all six platform services. `convergence-platform-readiness.json` reports all six ready; API health reports SQLite, Docker and Prometheus healthy. Live smoke checks in `convergence-platform-smoke.json` verify the 160-entry catalog and P1 controls, rebuilt web asset, named-latch Grafana dashboard, and six originally edited scenario JSON files unchanged byte for byte. Web: http://127.0.0.1:13002; API: http://127.0.0.1:13000; Grafana: http://127.0.0.1:13001. The requested restarted services remain running with the existing operator configuration.


## Parameter help refinement T102–T104 (2026-10-04)

All three Phase 9 tasks are complete. Each of the 160 audited catalog entries now has a concise purpose and separate operational explanation authored from the retained official target-version topic evidence in `p3/parameter-topics/`. P1 APW, BI cluster and BIW controls have matching operator help. The `-B` purpose is “Database memory cache size in blocks”; the `-Mxs` purpose correctly describes shared-memory overflow. Explanation fields are additive and optional on the existing options transport/schema, so retained older options remain valid and fall back to their purpose text.

Fixed and matrix selectors show their selected purpose immediately beneath the selector through `aria-describedby`. Detailed help is available through the circular accessible help trigger, with only the longer explanation, multi-user minimum/maximum/default, meaningful units and essential bound conditions in plain language, plus a discreet official reference link. Unpublished limits remain “Not specified in documentation”; nonnumeric limits remain “Not applicable”. Documented default discrepancies are retained in plain language without internal contract notes, duplicate units or source footnote markers. Availability and validation reasons stay visible separately. Backend metadata, native bounds/defaults, validation, argument transport, ownership and immutable scheduling behavior are unchanged.

Tooltip checks cover hover, keyboard focus/Enter, Escape, changing the selected parameter while open, desktop and narrow widths, and shrinking an already-open long tooltip to 360 × 400. The live check initially reproduced an off-screen positioning issue; the final shared `FieldHelp` clamps both axes and observes content size changes, keeping tooltips within the viewport with scrollable height when required. Live screenshots were reviewed for readable typography, spacing and bounds.

Evidence under `.parkbench/validation/feature021/`:

- `help-tests.log`: 1,005 passed, 30 explicitly gated skipped, zero failures across 1,035 checks. Includes scheduling/validation, catalog coverage, schema compatibility, named-latch and comparison warning/percentage regressions.
- `help-browser.log`: 88 passed, one licensed test gated skipped, zero failures. Includes all scheduling, preset and warning/percentage workflows and the reproduced window-resize regression.
- `help-final-focused.log`: nine final catalog/schema/help checks passed after text-default formatting, including legacy fallback, exact fractional units, documented conditions and discrepancies, and removal of duplicate units/footnote clutter.
- `help-final-browser.log`: nine final help/scheduling browser checks passed after the last formatting changes.
- `help-lint.log`, `help-typecheck.log`, `help-build.log`, `help-web-build.log`: pass. The web build retains its existing large-chunk advisory.
- `help-metadata-audit.json`: all catalog fields other than purpose/explanation match the pre-refinement catalog exactly. The full source inventory remains covered by the existing catalog contract checks.
- `help-scenario-preservation.json`: the six originally edited scenario JSON files remain byte-for-byte unchanged against the original saved working patch.
- `help-platform-restart.log`: compiled application and web assets rebuilt into platform images; all six services recreated with the existing operator configuration.
- `help-platform-readiness.json`: control-plane, web, Prometheus, Grafana, cAdvisor and node-exporter all ready.
- `help-platform-smoke.json`: live API dependencies healthy, 160/160 explanations returned, selected `-B` purpose and detailed tooltip verified in the rebuilt UI, including narrow-window containment. `help-live-tooltip.png`, `help-live-desktop.png` and `help-live-narrow.png` retain visual evidence.

This pass changes operator copy, additive help transport fields and presentation; no native lifecycle or transport behavior changed. The licensed/native acceptance recorded in the preceding phases remains distinct from the gated checks skipped here. The requested restarted platform remains running at http://127.0.0.1:13002 (web), http://127.0.0.1:13000 (API) and http://127.0.0.1:13001 (Grafana). All 104 feature tasks are checked. The post-implementation hook configuration is absent (`.specify/extensions.yml`), so no hooks are registered. Reviewer-owned checklist markers were not modified.


## APW capability configuration correction T105 (2026-10-04)

The operator reported `database_writer_unavailable:enterprise_required` while scheduling APWs with the configured Enterprise image. Diagnosis found the active profile and running control plane had an empty `PARKBENCH_OPENEDGE_DB_FEATURES`; the live options endpoint returned `features: []`. This was a ParkBench scheduling configuration rejection before OpenEdge startup, not an observed license rejection. The earlier native verification had not been followed by declaring the verified capability in the active deployment profile.

Re-ran the licensed run-control acceptance against the current configured `parkbench/openedge-db:dev` image (base profile `progresssoftware/prgs-oedb:12.8.11_ent`). Exact writer membership passed, including APW 2/9, BIW enabled/disabled, cluster/buffer application, same-run restart, capacity/startup mismatch, active writer-loss failure, source preservation and owned cleanup. Only after native proof, changed the active profile's single `PARKBENCH_OPENEDGE_DB_FEATURES` value from empty to `enterprise`; all other profile bytes remain unchanged. No license content was read or included in evidence; no native image or source database was modified.

Missing capability errors retain the existing `database_writer_unavailable:enterprise_required` classification/reason and now explicitly identify the unconfigured APW/BIW capability, `PARKBENCH_OPENEDGE_DB_FEATURES=enterprise`, and the control-plane restart requirement. Validation is unchanged: declared capability enables scheduling, and each run still requires native writer proof before measurement. `.env.example`, the operator guide and feature quickstart explain declaration, process/file precedence and recreation; the example's empty default remains conservative.

Evidence under `.parkbench/validation/feature021/apw-capability/`:

- `native-controls.log`: licensed run-control acceptance passed, 166.7 seconds, zero skipped. `native-acceptance.json` preserves this acceptance; `previous-native-acceptance.json` preserves the preceding result. Native source metadata/read-only assertions and owned cleanup passed.
- `capability-red.log`: regression reproduced the insufficient scheduling diagnostic; the explicit Enterprise path already permitted previews.
- `focused.log`: 14 checks passed, including configuration-to-options/preview propagation, actionable absent-capability APW/BIW failures, no-writer preview without Enterprise, frozen controls and `pending_native` verification.
- `tests.log`: 1,008 passed, 30 explicitly gated skipped, zero failures across 1,038 checks. This ordinary suite's gated skips are separate from the executed licensed acceptance above.
- `browser.log`: three fixed/sweep/catalog scheduling workflows passed, including zero/false retention.
- `lint.log` and `typecheck.log`: pass; `npm test` rebuilt the current application successfully.
- `profile-change.json`: only the active feature-list setting changed.
- `platform-restart.log` and `platform-readiness.json`: rebuilt control-plane/web platform images and recreated all six services; all report ready with the existing operator configuration.
- `live-smoke.json`, `live-smoke.log`, `live-preview.png`: rebuilt live options report Enterprise; the scheduling UI previews the existing authored write scenario with APW=2, BIW=true and inherited BI cluster size (HTTP 200). Capability remains `pending_native` at preview, as required. The queue is unchanged; this smoke check does not start a user's benchmark. API SQLite/Docker/Prometheus dependencies are healthy.

T105 is complete and all 105 feature tasks are checked. The platform remains running at http://127.0.0.1:13002. No reviewer-owned checklist markers changed; `.specify/extensions.yml` remains absent, so no post-implementation hooks are registered.


## Supplemental buffer hash latch factor T106 (2026-10-05)

Added `-hashLatchFactor` from the official OpenEdge 12.8 individual parameter topic, which was absent from the original alphabetical inventory. The shared catalog now contains 161 audited canonical definitions and covers 163 raw source names. Original alphabetical-list counts and aliases are retained, with the additional topic recorded as a supplement in both reference inventories.

The parameter accepts an integer percentage from 5 through 100, with a documented default of 10. Fixed and swept fixture previews freeze the literal `-hashLatchFactor n` broker argument. Short selector copy and detailed tooltip documentation explain latch allocation, rounding down, the minimum of two latches, the relationship to `-hash`, and startup-only behavior. No undocumented native reporting field or successful native observation is claimed. Native evidence remains unverified.

Validation evidence under `.parkbench/validation/feature021/`:

- `hash-latch-tests.log`: 1,009 passed, 31 gated tests skipped, zero failures across 1,040 tests. Includes catalog inventory, numeric boundaries and type rejection, fixed/swept fixture preview, broker argv, legacy schemas and comparison regressions.
- `hash-latch-browser.log`: 89 passed, one licensed browser test skipped; fixed/matrix selectors, purpose text, percentage bounds/default, detailed explanation and official reference passed.
- `hash-latch-lint.log`, `hash-latch-typecheck.log`, `hash-latch-web-build.log`: pass; web build retains the existing large-chunk advisory.
- Existing read-mix regression expectations were updated to preserve the operator-authored concurrency 35, current operation weights, predicate and 75-bucket sampling. Scenario JSON files were not changed by this supplemental task.

No actual benchmark workloads or database runs executed for this task. The initial full-suite invocation mistakenly set native gates to `0`; several older checks interpret any nonempty value as enabled and attempted native setup. These attempts failed because Docker/the live endpoint or required inputs were unavailable. That failed invocation is retained in `hash-latch-tests-initial.log`. The successful rerun explicitly used empty gate values, disabling both truthiness-based and `=== "1"` gates.

The compiled application and web build are ready. A current platform restart/live-options verification could not be performed: neither the configured Docker Desktop socket nor `/var/run/docker.sock` exists, and the control-plane endpoint at `127.0.0.1:13000` refuses connections. Earlier dated restart/acceptance evidence above describes the previous environment and does not establish current deployment of this addition. No experiments were submitted to an actual platform.
