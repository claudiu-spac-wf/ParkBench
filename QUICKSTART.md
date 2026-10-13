# ParkBench quickstart

ParkBench is a local control plane for repeatable Progress OpenEdge database and
PAS experiments. You describe what to exercise in a versioned scenario, provide
explicitly tagged images and private OpenEdge inputs, choose one or more parameter
variants, and let ParkBench create and destroy an isolated benchmark environment
for every run.

This document is the starting point for someone who has never seen ParkBench.
It explains the mental model and the normal workflows. The more detailed
runbooks are linked at the end.

## 1. The mental model

ParkBench has a persistent platform and a temporary benchmark stack.

```text
Persistent platform (one Compose project)

  Web UI ──> Control plane ──> SQLite + artifacts
                  │
                  └──────────────> Docker Engine

  Prometheus <── metrics from benchmark endpoints, cAdvisor, node-exporter
       │
       └── Grafana dashboards

Temporary stack (one unique Compose project per run)

  database <──private run network──> pas-1 ... pas-N
                                      │
                                      └── loadgen sends scenario requests

  loadgen, db-observer, pas-observer, file-sampler ──> shared metrics network
```

The control plane does not run the workload inside itself. It renders a unique
Docker Compose project, starts the database and PAS services, waits for
readiness, starts the load generator, collects measurements, stores evidence,
and removes only resources belonging to that run.

The important consequences are:

- A **scenario** is the reusable test definition.
- An **experiment** is a request to run a scenario with selected inputs and a
  matrix of variants.
- A **run** is one matrix cell and one repetition. Runs execute serially in the
  MVP so that host-resource measurements are not contaminated by another run.
- A run gets a fresh database volume, a unique Compose project name, and
  ownership labels. The database and PAS services stay on their private run
  network; only metrics endpoints join the persistent ParkBench metrics network.
- Grafana is useful for live visualization, but the retained SQLite summaries,
  raw Prometheus export, diagnostics, and `run-evidence.json` are the evidence
  for a completed run.

## 2. What the images do

There are two groups of images. The platform images keep ParkBench running; the
benchmark images are used by each generated run.

### Persistent platform images

| Image/service    | Role                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control-plane`  | Node.js API and orchestrator. Owns SQLite metadata and artifacts, talks to Docker through the Docker socket, renders run Compose files, and drives the lifecycle.                |
| `web`            | Nginx-served React Control UI. It calls the control-plane API; it does not execute benchmarks.                                                                                   |
| `prometheus`     | Scrapes workload, observer, container, and host metrics. Its local time-series data is retained independently of run cleanup.                                                    |
| `grafana`        | Displays dashboards over Prometheus. It is a visualization aid, not the source of retained evidence.                                                                             |
| `cadvisor`       | Supplies container CPU, memory, network, filesystem, and block-I/O measurements when exposed by the Docker host; its local web UI is published on port 18080 by default.        |
| `node-exporter`  | Supplies host-level metrics, including block-device measurements needed for the disk-I/O evidence gate.                                                                          |
| `loadgen-image`  | Build target for the explicitly tagged Node.js load-generator image. The image is used as the `loadgen` service in each run; the build-profile service itself is not long-lived. |
| `observer-image` | Build target for the explicitly tagged Node.js observer image. The same image can back the database observer, PAS observer, and file sampler services in a run.                  |

The platform images are described in `deploy/platform-compose.yml`. The loadgen
and observer support images are built from `docker/loadgen/Dockerfile` and
`docker/observer/Dockerfile`.

### Per-run benchmark images and services

| Run service/image                                    | Role                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database` / `PARKBENCH_OPENEDGE_DB_IMAGE`           | Licensed OpenEdge database server. The image carries no database: each run copies the selected on-disk seed (for example `one_gb_win`, database `parkbench`) into the run-owned `/psc/wrk` volume and serves it on broker port `20931`. Database parameters such as startup arguments and CPU limits are applied here. |
| `pas-1` ... `pas-N` / `PARKBENCH_OPENEDGE_PAS_IMAGE` | Licensed PAS for OpenEdge instances. The final image contains the ParkBench runner archive and exposes the configured HTTP endpoint, normally port `8810`; up to eight replicas are supported. PAS parameters such as maximum threads are applied here.                           |
| `loadgen` / `PARKBENCH_LOADGEN_IMAGE`                | Sends the scenario’s weighted HTTP operations to PAS using deterministic constant concurrency, records request latency/status/error data, and exposes Prometheus metrics plus a run summary.                                                                                      |
| `db-observer` / observer image                       | Runs the read-only OpenEdge database/VST observer. It exposes database-native metrics through `/metrics` and checks database readiness.                                                                                                                                           |
| `pas-observer` / observer image                      | Queries PAS management metrics for every PAS replica and checks application health. Credentials are passed by reference at runtime.                                                                                                                                               |
| `file-sampler` / observer image                      | Samples configured database or runtime file size and disk usage from the run-owned volume.                                                                                                                                                                                        |

The OpenEdge image builder also produces a licensed
`parkbench/openedge-observer` image and records it in the image manifest. The
generic `docker/observer` image is the normal Node.js observer support image;
the licensed observer variant is useful when the native OpenEdge runtime is
packaged into the observer image rather than mounted at runtime. Whichever
observer image is configured in `PARKBENCH_OBSERVER_IMAGE` must use an explicit
tag other than `latest` and satisfy the observer contract. An optional
`@sha256:...` suffix gives the run a stronger immutable identity.

Do not confuse the generic and final OpenEdge PAS images:

- **Generic** is reusable runner plumbing only. It has
  `parkBenchReady=false` and is deliberately rejected as a real workload input.
- **Final** contains the compiled workload procedures and has
  `parkBenchReady=true`. It is the only valid PAS image for an OpenEdge
  workload run.

## 3. Vocabulary and inputs

ParkBench’s Catalog screen groups inputs into seven categories:

- **Docker images**: database, PAS, loadgen, observer, or unclassified images.
- **Scenarios**: immutable `scenario.v1` JSON documents and their versions.
- **Workloads**: ABL procedure source files discovered below
  `openedge/workloads/Workloads`.
- **Observers**: observer declarations or custom observer assets.
- **Seeds**: Linux OpenEdge database folders on disk under the seeds root, such as `one_gb_lnx/`.
- **Archives**: PAS runner/application archives, such as `oepas1.zip`.
- **Configurations**: managed configuration inputs.

An asset can be used only when it is available, classified, verified, ready, and
identified by a valid image tag or content checksum. Docker images must use an
explicit tag other than `latest`; an `@sha256:<64 hex characters>` suffix is
optional. Files are represented by content-addressed
`input:<category>#<sha256>` references in the catalog. A stale, malformed,
unclassified, mutable, or unverifiable asset is visible for diagnosis but
cannot be selected for a new run. Tag-only images are intentionally supported,
but a tag can be retargeted; use a digest when exact reproducibility matters.

The important private inputs are supplied locally or by a private registry:

- Progress installation assets, normally `../IMAGES`.
- The private `../progress.cfg` license file.
- An imported compatible JDK image.
- Database seed and PAS runner archive.
- Optional runtime credentials and a read-only database observer launcher.

These values, their contents, and secret values must not be committed. ParkBench
stores references, optional image digests, and file checksums, not licenses,
passwords, or private installation material.

## 4. First setup

### Requirements

For fake mode, install Node.js 24 or newer and npm. For the real platform, also
use Docker Engine with Compose v2 on a Linux x86_64 host, or a compatible Docker
Desktop/WSL setup. A native Linux Docker host is preferred for complete disk-I/O
evidence because Docker Desktop may not expose per-container block-I/O series.

### Install and configure

From the repository root:

```bash
npm ci
cp .env.example .env.local
npm run build
```

Edit `.env.local`. The file is organized into commented sections: core host
bindings, storage/path mappings, observability, platform images, discovery
roots, loadgen/observer images, private OpenEdge inputs, OpenEdge build inputs,
and OpenEdge runtime defaults. At minimum, a Docker platform needs explicitly
tagged (not `latest`) `PARKBENCH_LOADGEN_IMAGE` and
`PARKBENCH_OBSERVER_IMAGE`, plus the data-root settings. Digests are optional.
When the control plane runs inside Docker,
`PARKBENCH_HOST_DATA_ROOT` and `PARKBENCH_DOCKER_HOST_PATH_ROOT` must be the
same absolute host directory so that paths created in the control-plane
container are visible to the Docker daemon.

ParkBench-owned npm commands and helper scripts automatically load `.env.local`
from the repository root. The `--config` option remains available when a
command must use a different environment file. Use `./scripts/compose.sh` for
generic Compose actions so the selected environment file and Docker target are
preserved. Relative host paths resolve from the repository root. In the
containerized control plane, host data under `PARKBENCH_DOCKER_HOST_PATH_ROOT`
is available at `/var/lib/parkbench`; generated OpenEdge seed, archive, and
manifest files must be inside that mapped root.

For a clean machine state with no generated ParkBench images or artifacts, use
the ordered bootstrap after the imported OpenEdge images, licensed inputs, and
compiler adapter are configured:

```bash
./scripts/bootstrap.sh
```

It validates the inputs first, builds application assets before images that
copy them, builds generic OpenEdge images before the final workload image,
loads the final generated `images.env` only after those images exist, starts
the platform, and waits for a healthy control plane. Keep the imported
Progress references in `PARKBENCH_OPENEDGE_DB_BASE_IMAGE` and
`PARKBENCH_OPENEDGE_PAS_BASE_IMAGE`; the corresponding `PARKBENCH_OPENEDGE_*_IMAGE`
values are the generated runtime images.

Keep `PARKBENCH_BIND_ADDRESS=127.0.0.1` for a trusted local workstation. The
default endpoints are:

| Service           | URL                      |
| ----------------- | ------------------------ |
| Web UI            | `http://127.0.0.1:13002` |
| Control-plane API | `http://127.0.0.1:13000` |
| Grafana           | `http://127.0.0.1:13001` |
| Prometheus        | `http://127.0.0.1:19090` |

To start just the fake lifecycle check, no Docker platform or licensed inputs
are needed:

```bash
npm run smoke:fake
```

To start the local platform after setting the support image references:

```bash
npm run build
./scripts/compose.sh up -d
```

Or use the wrappers:

```bash
./scripts/setup.sh       # install dependencies and create .env.local
./scripts/start.sh       # build and start the platform
./scripts/status.sh
./scripts/logs.sh        # optionally: ./scripts/logs.sh control-plane
./scripts/stop.sh        # stop without deleting persistent volumes
```

If the support images do not exist yet, build them first with
`./scripts/start.sh --build-images` or:

```bash
./scripts/compose.sh --profile build build loadgen-image observer-image
```

After building, put each local image's explicit non-`latest`
`repository:tag` reference in `.env.local`. You may append the inspected
`@sha256:...` digest when you need stronger reproducibility. Mutable tags and
`latest` are rejected during preflight.

## 5. The real OpenEdge image workflow

The OpenEdge builder creates the database, PASOE, and observer artifacts in two
stages. It never downloads or commits licensed material.

1. Make sure the imported Progress DB/PASOE base images and compatible JDK image
   are available to Docker. Make sure `../IMAGES` and `../progress.cfg` exist.
2. Configure the compiler adapter. On Linux:

   ```bash
   export PARKBENCH_OPENEDGE_COMPILER="$PWD/scripts/openedge/compile-with-db.mjs"
   chmod +x "$PARKBENCH_OPENEDGE_COMPILER"
   ```

3. Run the fail-closed input check:

   ```bash
   npm run openedge:preflight -- \
     --progress-root ../IMAGES \
     --license ../progress.cfg \
     --jdk-image "$PARKBENCH_OPENEDGE_JDK_IMAGE"
   ```

4. Build both stages:

   ```bash
   npm run openedge:build -- \
     --progress-root ../IMAGES \
     --license ../progress.cfg \
     --jdk-image "$PARKBENCH_OPENEDGE_JDK_IMAGE" \
     --image-stage all
   ```

Generated outputs go below `.parkbench/openedge/` (ignored by Git):

- `stages/generic/manifest.json` describes the reusable intermediate images and
  must say `parkBenchReady=false`.
- `manifest.json` describes the final images, seed/archive checksums, workload
  provenance, and build timing. It must say `imageStage=final` and
  `parkBenchReady=true`.
- `images.env` contains the generated DB/PAS image references and private file
  paths to load into the local environment.

`./scripts/start.sh` and `./scripts/compose.sh` automatically load the final
`images.env` handoff when it exists, including during a partial control-plane
redeploy. This preserves the native OpenEdge observer image and compiled
procedure even when the corresponding `.env.local` settings are blank.

For other commands, merge the final values from `images.env` into `.env.local`. ParkBench-owned
commands automatically load `.env.local`, so do not source that file manually.
If you keep the generated file separate instead, source only `images.env` in
the shell used for the command; its exported values take precedence over the
automatically loaded `.env.local` values. The final manifest is required for
scenarios using `POST /work`:

```bash
set -a
. ./.parkbench/openedge/images.env
set +a

npm run preflight -- \
  --scenario examples/scenarios/parkbench-bank-mix.json
```

The standard OpenEdge image contract uses the selected seed's database (for
ParkBenchDB seeds, `parkbench`), broker `20931`, dynamic ports `20932-20941`, PAS instance `oepas1`,
HTTP port `8810`, and the runner archive `oepas1.zip`.

## 6. Scenarios: what to define

A scenario is an immutable JSON document. Start from
`examples/scenarios/crud-rest.json` for a generic REST demonstration or
`examples/scenarios/parkbench-bank-mix.json` for the OpenEdge runner.

The main sections are:

- `target`: REST operation path, protocol/port, database and PAS service names,
  PAS replica count (1–8), health path, and request timeout.
- `workload.operations`: weighted HTTP operations. Each operation defines an
  ID, method, path, optional JSON body template, and expected status codes.
- `workload.load`: currently `constant-concurrency`, with concurrency,
  per-worker in-flight limit, and a deterministic random seed.
- `phases`: warmup, measurement, and cooldown durations. Metrics are labeled by
  phase; the measurement phase is the part used for performance results.
- `observers`: required or optional metric sources, sampling interval, metric
  names, and observer configuration.
- `requiredMeasurements`: optional declarations that make specific metrics and
  phases part of evidence completeness.
- `assetRefs`: optional catalog links for the workload, database image, PAS
  image, and observers.

For an OpenEdge runner operation, keep the HTTP operation at `POST /work` and
put all procedure-specific data inside the fixed request envelope:

```json
{
  "procName": "Workloads/Read/mixed_table_large_reads.p",
  "input": { "iterations": 1, "rowsPerTable": 100 }
}
```

The actual PASOE WEB URL is
`http://<pas-host>:8810/parkbench/web/work`; ParkBench keeps `/work` as the
scenario operation path and adds the transport base path when generating the
run Compose file.

In the Control UI, a scenario version can also declare typed, non-secret
database parameters. Each definition has a canonical name, type, description,
source, default/range or allowed values, dependency rules, and whether it is
allowed in a matrix. These definitions are what make parameter editing and
matrix expansion safe and reproducible. Secrets are never UI-editable
parameters.

## 7. Create a new workload, scenario, or observer

### Add a workload procedure

1. Add an ABL procedure below `openedge/workloads/Workloads`.
2. Give it exactly one input parameter:

   ```abl
   DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
   ```

3. Use a canonical POSIX procedure name beginning with `Workloads/`, ending in
   `.p`, with no traversal or encoded separators.
4. Parse the compact JSON value in `SingleParam`. Put workload-specific values
   inside the scenario operation’s `input` object; do not change the dispatcher
   envelope.
5. Rebuild the final image. The builder discovers the source, validates the
   signature, compiles it against the compile seed's schema (`PARKBENCH_OPENEDGE_COMPILE_SEED`), packages
   it into `oepas1.zip`, and records source/compiled checksums in the final
   manifest.
6. Add or update a scenario operation whose body template names the procedure,
   increment the scenario version when the contract changes, refresh the
   Catalog, and verify the resulting assets before scheduling a run.

The generic PASOE image is not sufficient after step 5; use the final image.
The runner returns `200` for a successful procedure, bounded `4xx`/`5xx` errors
for invalid or failed requests, and a 60-second timeout boundary for a timeout
or no response. A timeout stops the load and makes the owning run `FAILED`; its
latency is retained only as a lower-bound observation.

### Add a database/PAS/support image

Use an explicit non-`latest` image tag; add a digest when exact reproducibility
is needed. Make the image consume the declared
parameter contract. Database images must consume
`PARKBENCH_OPENEDGE_DB_STARTUP_ARGS` and `PARKBENCH_DATABASE_READ_ONLY` when
declared; PAS images must consume `PARKBENCH_PAS_MAX_THREADS`. If the image
does not apply a declared factor, the benchmark is not valid even if the
container starts.

For the standard licensed OpenEdge images, change the local Progress inputs or
workload sources and use the two-stage OpenEdge builder. For loadgen or generic
observer support images, use the corresponding Dockerfile and build profile,
then optionally record the output digest. Register the image in the Catalog
only with safe provenance and a checksum; never upload its private contents or
credentials through the UI.

### Add an observer

Use a built-in declaration (`core`, `openedge_db_v1`, `openedge_pas_v1`, or
`file_sampler_v1`) when possible. For a new adapter, use a versioned kind such
as `cache_v1`, implement `ready()` and `sample(context)`, define its health and
completeness behavior, and register the adapter when creating the platform.
Samples must retain the coordinator’s run, experiment, variant, repetition, and
phase labels. Required observers that are unavailable fail preflight; optional
observers remain visible as incomplete or degraded evidence.

## 8. Run an experiment

The normal UI path is:

1. Open the Overview screen and confirm SQLite, Docker, Prometheus, and Catalog
   health.
2. Open Catalog and rescan the Docker and managed filesystem roots. Verify the
   required images, scenario, workload, seed, archive, and observer inputs.
3. Open Schedule, select a scenario version, and enter only declared parameter
   values and approved private input references.
4. Preview the matrix. ParkBench expands the Cartesian product in declared
   dimension order. For example, four values for `-B` crossed with four values
   for `-B2` creates 16 cells; repetitions create additional runs in cell order.
5. Review the effective values, run count, and warning, then explicitly confirm
   the preview. Previews expire after five minutes and submission verifies the
   request hash and idempotency key.
6. Start the queue. Preflight runs before any run-owned containers, networks, or
   volumes are created. Temporary capacity pressure is retried at 5, 15, 30,
   and 60 seconds; permanent prerequisite failures are blocked with diagnostics.
7. Monitor the Queue and active-run view. The lifecycle is broadly:
   `QUEUED` → `PROVISIONING` → database/PAS ready → `WARMING_UP` →
   `MEASURING` → `COOLDOWN` → terminal state.
8. After completion, use History for summaries, diagnostics,
   `run-evidence.json` (with the Prometheus queries for the run's series), provenance, and cleanup status. Use Comparison to select
   any eligible completed run as a baseline, or leave the baseline empty for a
   descriptive-only comparison. A baseline is not chosen during submission.

The terminal states have different meanings:

- `SUCCEEDED`: workload and required evidence completed successfully.
- `THRESHOLD_FAILED`: workload completed but a declared performance threshold
  failed.
- `INCOMPLETE`: the run finished but required measurements were missing or
  stale.
- `FAILED`: infrastructure, readiness, workload, export, or other hard failure.
- `CANCELLED`: an operator cancelled queued or active work.
- `INTERRUPTED`: the process stopped unexpectedly and reconciliation preserved
  the diagnostic state.

## 9. What a completed run contains

ParkBench stores an environment snapshot containing the scenario version, input
provenance, effective parameter values, deterministic load seed, host/Docker
metadata, and resolved image references with their identity strength (tag or
digest). It also stores:

- Request counts, errors, timeouts, throughput, and latency summaries.
- PAS, database, workload, container, host, disk-I/O, and file observations as
  available.
- The Prometheus queries and time windows that locate the run's time series.
  The series stay in Prometheus (365-day retention by default); they are not
  copied to disk.
- Phase boundaries and observer completeness/health.
- Diagnostics, generated Compose configuration, and ownership-scoped cleanup
  results.
- A `run-evidence.v2` artifact tying the result back to the scenario, images,
  seed/archive checksums, workload, measurements, and cleanup.

This is why a result can be reviewed later even when the original run
containers are no longer available. The raw series need Prometheus and its
data volume.

## 10. Troubleshooting and safe habits

- **Asset is not selectable:** rescan Catalog, verify the file/image, and use a
  valid non-`latest` image tag or content checksum. Unclassified local Docker
  images are intentionally blocked.
- **`final_openedge_manifest_required`:** build the `final` or `all` stage and
  configure `PARKBENCH_OPENEDGE_IMAGE_MANIFEST` together with the exact DB/PAS
  references from that manifest.
- **Platform cannot see run files:** check that
  `PARKBENCH_HOST_DATA_ROOT` and `PARKBENCH_DOCKER_HOST_PATH_ROOT` are the same
  absolute host path when the control plane is containerized.
- **Readiness timeout:** inspect the control-plane and generated run logs. Check
  the database broker, PAS health path, `oepas1`, port `8810`, and the observer
  configuration.
- **`INCOMPLETE` disk evidence:** verify cAdvisor and node-exporter block-device
  sources. `PARKBENCH_SMOKE_SKIP_DISK_IO=1` is a diagnostic Docker Desktop/WSL
  opt-out only; it does not produce a complete benchmark gate.
- **Never clean up by broad Docker commands.** Cancel from the UI or use the
  run’s recorded cleanup path. ParkBench verifies ownership labels before
  deleting run resources; `scripts/stop.sh` stops the persistent platform and
  deliberately leaves its persistent volumes in place.

## Further reading

- [`README.md`](README.md): repository overview and command summary.
- [`docs/quickstart.md`](docs/quickstart.md): concise setup and smoke commands.
- [`docs/operator-runbook.md`](docs/operator-runbook.md): lifecycle behavior and
  operational troubleshooting.
- [`docs/scenario-authoring.md`](docs/scenario-authoring.md): scenario contract.
- [`docs/workload-authoring.md`](docs/workload-authoring.md): ABL runner contract.
- [`docs/observer-authoring.md`](docs/observer-authoring.md): observer adapter
  contract.
- [`docs/openedge-image-build.md`](docs/openedge-image-build.md): licensed image
  build details.
- [`deploy/platform-compose.yml`](deploy/platform-compose.yml): persistent
  platform topology.
- [`deploy/run-compose/template.yml`](deploy/run-compose/template.yml): base
  per-run topology.
