# OpenEdge validation record

This record separates checks that can run without Progress runtime execution from the gated Docker/PASOE validation. The September 2026 evidence below describes the earlier workflow; current feature gate results are recorded in the companion planning feature's `quickstart.md`.

## Current disk catalog and scheduling workflow

Set `PARKBENCH_DISCOVERY_SCENARIOS_ROOT`, `PARKBENCH_DISCOVERY_WORKLOADS_ROOT`, `PARKBENCH_DISCOVERY_OBSERVERS_ROOT`, `PARKBENCH_DISCOVERY_SEEDS_ROOT`, and `PARKBENCH_DISCOVERY_ARCHIVES_ROOT` to managed host directories. `scripts/start.sh` bind mounts them into the control plane, so editing a scenario or workload does not require an image rebuild. Catalog shows only current files in these five roots. Scenario choices come from `.json` files, one choice per path; a non-JSON file such as `README.md` does not appear. Edit scenarios and other assets on disk, then refresh Catalog.

Overview provides **Verify all scenarios**, **Compile all workloads**, and **Rebuild archive**. The rebuild requires a custom filename base and publishes `<name>.zip` under the archive root without an automatic version. Compilable workloads remain available when a sibling fails compilation; the archive manifest records included and excluded procedures. Use a new name for a later rebuild. A scenario can use a partial archive only when all its required compiled procedures are included. An older archive without a manifest is checked by its nested compiled entries.

Schedule accepts a path-derived scenario choice, seed, archive, and database broker parameter dimensions. It uses `PARKBENCH_OPENEDGE_DB_IMAGE`, `PARKBENCH_OPENEDGE_PAS_IMAGE`, and the configured PAS metrics credential. Configure `PARKBENCH_OPENEDGE_VERSION` and any supported `PARKBENCH_OPENEDGE_DB_FEATURES` so only applicable parameter choices appear. Each option explains its purpose, unit, and availability. The curated list and later-use notes are in the companion planning file `specs/012-simplify-run-workflow/performance-parameters.md`. A `startup.pf` beside the database file in the seed archive supplies startup values; scenario defaults and queued values override it in that order. The preview and saved run show the effective value and source. Before measurement, the live broker's `_DbParams` values must agree with requested values.

Author new observers in `scenario.v2` without a `metrics` selector. ParkBench exports every valid metric returned by an enabled observer. Legacy `scenario.v1` selectors remain readable but do not filter output. Required measurements are validated separately.

## Non-live validation

The following checks passed for the earlier workflow:

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`
- `git diff --check`

The latest full test run reported 108 tests: 104 passed, 0 failed, and 4 live
OpenEdge tests skipped because the explicit live-test flag was not enabled.

The gated tests now contain executable final-image/PASOE and Docker Compose
coverage for workload success, input propagation, application failure, missing
procedures, timeout/no-response boundaries, malformed archives, signature
validation, baseline/variant evidence, raw-export artifacts, and ownership
cleanup. They require the licensed runtime and are intentionally skipped until
the live-test flag is enabled.

To enable them after the final PASOE image is running, provide the compiler and
runtime inputs described in the quickstart and set
`PARKBENCH_RUN_OPENEDGE_TESTS=1` and
`PARKBENCH_OPENEDGE_TEST_BASE_URL=http://127.0.0.1:8810/parkbench/web` before
running the integration suite.

The contract, security, and non-live integration suites use synthetic manifests and local HTTP fixtures. They do not copy the private Progress license or supplied Progress archives into tracked files.

The build scripts also verify that generated outputs are staged below the ignored
OpenEdge output root, private inputs are removed after staging, and image
references use explicit non-`latest` tags before a final manifest is emitted.
Image references are used as configured without content checks.

The non-live checks also cover the clean-output boundary, canonical workload
paths, one-minute timeout evidence, raw-export-before-cleanup ordering, and
run-owned resource cleanup. The final workload-complete build completed in
39,914 ms total, below the under-10-minute image-build goal.

## Live validation gate

The current local preflight command is:

```text
node scripts/openedge/preflight.mjs --progress-root ../IMAGES --license ../progress.cfg --jdk-image eclipse-temurin:17.0.20_8-jdk --jdk-path /opt/java/openjdk
```

On 2026-09-17, the configured JDK was verified as Linux/amd64 Temurin
17.0.20+8 at
`eclipse-temurin:17.0.20_8-jdk`.
Preflight passed with the supplied Progress assets, license, and imported
12.8.11 DB/PASOE images.

The generic stage completed successfully in 55,145 ms. It produced explicitly
tagged generic DB, PASOE, and observer images:

```text
parkbench/openedge-db:12.8.11-sports2020-generic
parkbench/openedge-pasoe:12.8.11-runner-generic
parkbench/openedge-observer:12.8.11-db-observer
```

The generic manifest is correctly gated with `imageStage=generic` and
`parkBenchReady=false`; it is not a ParkBench workload input.

The final stage now succeeds with the supplied DB-backed compiler adapter. For
each source file it starts the exact generic DB image, waits for the `sports`
broker, runs `pro` with the ABL `COMPILE VALUE(sourcePath) SAVE` driver, and
removes the temporary compiler container. The current final manifest records:

```text
parkbench/openedge-db:12.8.11-sports2020-generic
parkbench/openedge-pasoe:12.8.11-runner-final-1a6cb99903df4497
parkbench/openedge-observer:12.8.11-db-observer
final build duration: 39,099 ms; generic-to-final total: 39,914 ms
```

The final archive contains both source and compiled `.r` files for the handler
and `Workloads/Read/mixed_table_large_reads.p`. A fresh disposable DB/PASOE
validation then confirmed readiness, `GET /parkbench/web/health` (200),
`GET /parkbench/web/metrics` (200), and a Sports2020-backed
`POST /parkbench/web/work` (200, 6 ms for one iteration and one row per table).
PASOE logs confirmed sessions connected to database `sports`. This direct
endpoint check is not the complete ParkBench validation matrix.

The complete image/workload ParkBench smoke was run on 2026-09-17 with the
Docker Desktop/WSL-specific command below. Both declared variants completed
successfully, and each run recorded readiness, successful Sports2020 workload
requests, core/PASOE/database/file observer evidence, a raw
export, and ownership-verified cleanup:

```text
PARKBENCH_SMOKE_SKIP_DISK_IO=1 npm run smoke:openedge -- --config .env.local --scenario examples/scenarios/sports2020-workload.json
```

The baseline run was `run_9e8591ed-7c01-433b-9803-7cb320c95b57`: 92 completed
requests, 0 errors, 0 timeouts, p50 16.820 ms, p95 46.220 ms, p99 65.777 ms,
and 4,918 exported samples. The `-B=10000` variant was
`run_c3e1b93f-4097-4a17-98e9-48d81e5e9242`: 145 completed requests, 0 errors,
0 timeouts, p50 12.015 ms, p95 20.172 ms, p99 33.985 ms, raw export SHA-256
5,270 exported samples. Both runs observed 2/2 measurement samples for core,
OpenEdge DB, OpenEdge PASOE, and file observers, and both cleanup statuses are
`COMPLETE` with ownership verification.

This local command intentionally disables only the required cAdvisor disk-I/O
gate. Docker Desktop exposes host/cgroup metrics to the cAdvisor container but
does not expose per-container block-I/O series, so accepting those series here
would fabricate evidence. Production/default runs still require both
container and host disk-I/O sources; the full SC-003–SC-008 observability gate
must be rerun on a native Linux Docker host (or an equivalent Docker engine
that exposes the required cAdvisor series). The run evidence keeps the disabled
groups empty rather than treating them as zero.

The smoke process returned experiment status `SUCCEEDED`; no run-owned
containers, network, volumes, target file, or other resources remained after
cleanup. The raw exports were registered before cleanup. The image/workload
and local Docker Desktop validation slice is complete, but T054 and T056 remain
open because the complete required disk-I/O gate still needs a compatible
Docker host.

In the current WSL2 shell, Docker Desktop is reachable through the Linux
`docker` command. Its cAdvisor instance is healthy, but the Docker Desktop
engine does not provide the per-container block-I/O series required by the
default gate; see the explicit smoke-only validation command above.

No `progress.cfg`, supplied Progress archive, JDK layer, generated image, or
private runtime path is present in tracked files. The generated final manifest
contains the final image and archive references, and the two smoke runs index their raw-export artifacts.

For a complete observability validation, run the same flow on native Linux
Docker without `PARKBENCH_SMOKE_SKIP_DISK_IO=1` and append the resulting
container/host disk-I/O evidence here. The gated integration suite remains
available with `PARKBENCH_RUN_OPENEDGE_TESTS=1`; it was not enabled during the
non-live test run.

## Timeout interpretation

The workload deadline is 60,000 ms. A timeout or no-response result stops further load and marks the owning run `FAILED`. Its latency is recorded as a lower-bound observation and is excluded from completed-success percentile calculations; it is evidence of the minimum observed time to complete, not an upper-bound performance result.
