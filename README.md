# ParkBench

ParkBench is a local benchmark control plane for reproducible Progress
OpenEdge 12.8 database and PAS experiments. It creates run-owned Docker
Compose projects, drives deterministic workloads, stores lifecycle metadata in
SQLite, and collects Prometheus metrics. Each run's time series stay in
Prometheus; the run records the queries and windows that locate them.

The repository contains the TypeScript control plane, load generator, observer
adapters, scenario contracts, and the optional OpenEdge workload-runner image
toolchain. Licensed OpenEdge inputs stay local; they are never checked into
Git or copied into ordinary artifacts.

## Prerequisites

For development and fake-mode runs:

- Node.js 24 or newer and npm.
- Git.

For the platform and licensed OpenEdge runs:

- Docker Engine with Docker Compose v2 on a Linux x86_64 host. ParkBench uses
  the Engine selected by the Docker CLI and does not require a named context.
- Explicitly tagged loadgen and observer support images.
- The imported Progress OpenEdge database and PASOE base images.
- A compatible imported JDK image, the private Progress package tree, and the
  private `progress.cfg` license file.

The default local input layout is `../IMAGES` and `../progress.cfg` relative to
the repository root. See [`docs/operator-inputs.md`](docs/operator-inputs.md)
for the input boundary and [`docs/version-pinning.md`](docs/version-pinning.md)
for image identity and versioning guidance.

## Install and configure

From the repository root:

```bash
npm ci
cp .env.example .env.local
npm run build
```

Edit `.env.local` with the local support images and paths. Image settings must
use an explicit tag other than `latest`; `@sha256:...` digests are optional. At
a minimum, a Docker platform run needs `PARKBENCH_LOADGEN_IMAGE`,
`PARKBENCH_OBSERVER_IMAGE`, `PARKBENCH_HOST_DATA_ROOT`, and
`PARKBENCH_DOCKER_HOST_PATH_ROOT`. The two host path values must resolve to the
same absolute directory when the control plane itself runs in Docker.

ParkBench-owned npm commands and helper scripts automatically load `.env.local`
from the repository root. You normally do not need to source it manually. If
you are running a command outside those entry points, load it for the current
shell explicitly:

```bash
set -a
. ./.env.local
set +a
```

Do not put passwords, license contents, Progress archives, database seeds, or
private runtime paths into tracked files. `.env.local`, `.parkbench/`, and
licensed input patterns are ignored by Git.

## Run the fake smoke test

Fake mode exercises scenario validation, the baseline/variant matrix, run
lifecycle transitions, observers, metrics, the Prometheus metrics reference,
and ownership-scoped cleanup without licensed OpenEdge images or Docker resources:

```bash
npm run smoke:fake
```

This is the fastest first check after installation. The control-plane API,
Prometheus, and Grafana are not required for this command.

## Start the local platform

After configuring the support image references, build the application and
start the persistent services:

```bash
./scripts/start.sh
```

The services are available at:

- Web UI: <http://127.0.0.1:13002>
- Control-plane API: <http://127.0.0.1:13000>
- Prometheus: <http://127.0.0.1:19090>
- Grafana: <http://127.0.0.1:13001>
- cAdvisor UI: <http://127.0.0.1:18080>

The host ports are configurable in `.env.local` with
`PARKBENCH_*_HOST_PORT`. Keep `PARKBENCH_BIND_ADDRESS=127.0.0.1` for
local-only access; the start script prints the actual published endpoints.

The same workflow is available through the repository helper scripts:

```bash
./scripts/setup.sh          # once: install dependencies and create .env.local
./scripts/start.sh          # build and start the local platform
./scripts/status.sh         # inspect service status
./scripts/logs.sh           # follow service logs
./scripts/stop.sh           # stop without removing persistent volumes
```

Use `./scripts/start.sh --build-images` when the loadgen and observer support
images also need to be built. See [`scripts/README.md`](scripts/README.md) for
test, smoke, preflight, and other helper commands.

Build the support images once if they are not already available:

```bash
./scripts/compose.sh --profile build build loadgen-image observer-image
```

The platform requires explicit non-`latest` image tags. Operator supplied
`@sha256:...` references are accepted as Docker references, but ParkBench does
not generate or compare image digests. `latest` is rejected during preflight.

## Operate through the Control UI

The local web app reads scenarios, workloads, observers, seeds, and archives
from the configured managed directories. Overview verifies every scenario,
compiles every workload, and rebuilds a named archive. Schedule uses the
configured DB/PAS images and credential, offers database broker parameters,
and previews the Cartesian matrix before confirmation. Queue lists waiting
runs; History holds completed runs and their saved Grafana links.
Every valid matrix requires explicit confirmation; submission itself does not
choose a baseline. Any eligible completed run can be selected as the baseline
later, or the comparison can remain descriptive-only. See
[`docs/control-ui.md`](docs/control-ui.md) and
[`docs/validation/control-ui.md`](docs/validation/control-ui.md).

## Build the OpenEdge images

The OpenEdge builder has two stages. `generic` validates the reusable runner
and image plumbing but is not a valid ParkBench workload image. `final` adds
compiled procedures and produces the only ParkBench-ready manifest. `all` runs
both stages in order.

First verify the private inputs and imported images:

```bash
docker image inspect progresssoftware/prgs-oedb:12.8.11_ent
docker image inspect progresssoftware/prgs-pasoe:12.8.11
docker image inspect "$PARKBENCH_OPENEDGE_JDK_IMAGE"
```

Configure the compiler adapter for the final stage, then build:

```bash
export PARKBENCH_OPENEDGE_COMPILER="$PWD/scripts/openedge/compile-with-db.mjs"
chmod +x "$PARKBENCH_OPENEDGE_COMPILER"

npm run openedge:preflight -- \
  --progress-root ../IMAGES \
  --license ../progress.cfg \
  --jdk-image "$PARKBENCH_OPENEDGE_JDK_IMAGE"
npm run openedge:build -- \
  --progress-root ../IMAGES \
  --license ../progress.cfg \
  --jdk-image "$PARKBENCH_OPENEDGE_JDK_IMAGE" \
  --image-stage all
```

Generated files are written below `.parkbench/openedge/`. The generic-stage
manifest is under `stages/generic/` and must say `parkBenchReady=false`. The
root `manifest.json` and `images.env` are emitted only after the final
workload-complete PASOE image succeeds; they contain image references, workload
provenance, and build timing.

See [`docs/openedge-image-build.md`](docs/openedge-image-build.md) for staged
build details and Windows/WSL compiler configuration.

## Select the seed and run the licensed smoke test

Runs start from a seed: a Linux OpenEdge database folder on disk under
`PARKBENCH_DISCOVERY_SEEDS_ROOT` (see
[`docs/quickstart.md`](docs/quickstart.md#seed-databases)).
Set `PARKBENCH_OPENEDGE_DEFAULT_SEED` to the seed folder name (for example
`one_gb_lnx`), load the generated final-stage values into `.env.local`,
configure the approved read-only database observer, and select the dedicated
scenario:

```bash
npm run preflight -- \
  --config .env.local \
  --scenario examples/scenarios/parkbench-bank-mix.json
npm run smoke:openedge -- \
  --config .env.local \
  --scenario examples/scenarios/parkbench-bank-mix.json
```

The smoke test runs a baseline with no database startup override and a variant
with only `-B=10000`. The operator chooses the scenario, inputs, workload,
phase durations, and observer set for each run.
Successful validation includes readiness, `POST /work`, workload/PAS/database
metrics, host/container disk-I/O and file samples, `run-evidence.v2` (which
records the Prometheus queries and windows for the run's time series), and
cleanup of only run-owned resources. Run time series stay in Prometheus; they
are not copied to disk.

On Docker Desktop/WSL, cAdvisor may not expose per-container block-I/O data.
For a diagnostic smoke run only, use:

```bash
PARKBENCH_SMOKE_SKIP_DISK_IO=1 npm run smoke:openedge -- \
  --config .env.local \
  --scenario examples/scenarios/parkbench-bank-mix.json
```

This opt-out does not produce complete disk-I/O evidence. Use a native Linux
Docker host for the fully valid benchmark gate. A `/work` timeout or no
response at 60,000 ms stops load, marks the run `FAILED`, records a lower-bound
timeout observation, exports raw metrics, and then performs cleanup.

## Tests and code quality

The usual non-live checks are:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:contract
npm run test:security
npm run test:integration
```

The OpenEdge integration and live smoke tests are gated: they require the
private Progress inputs, a compatible JDK/compiler, imported images, Docker,
and the configured observer. Run the non-live checks first. Do not replace
missing licensed inputs with tracked copies or weaken the preflight gates.

## Adding a workload

Add an ABL procedure below `openedge/workloads/Workloads` with exactly one
input parameter:

```abl
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
```

Use a canonical POSIX procedure name such as
`Workloads/Read/mixed_table_large_reads.p`. Put workload-specific values inside
the JSON `input` object, compile the workloads from Overview, and rebuild an
archive under a new name. The source path in a scenario must appear in the
selected archive's compiled contents. The generic image is not a valid workload
image. See [`docs/workload-authoring.md`](docs/workload-authoring.md).

## Repository guide

- [`docs/quickstart.md`](docs/quickstart.md): end-to-end setup and smoke flow.
- [`docs/operator-runbook.md`](docs/operator-runbook.md): runtime behavior and
  troubleshooting.
- [`docs/openedge-validation.md`](docs/openedge-validation.md): validation
  record and evidence requirements.
- [`docs/scenario-authoring.md`](docs/scenario-authoring.md): scenario format.
- [`docs/security-boundaries.md`](docs/security-boundaries.md): safety and
  ownership boundaries.
- The companion `ParkBenchPlanning` repository contains the feature
  specifications and versioned design contracts.

To stop the persistent platform, run:

```bash
./scripts/stop.sh
```
