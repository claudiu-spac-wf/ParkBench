# Quickstart

The supported initial migration profile is Ubuntu 26.04.1 LTS on x86_64. Install
Node.js 24 or later, Docker CLI/Engine, and the Compose plugin; the setup checks
their capabilities without pinning exact Docker or Compose versions. ParkBench
uses the Docker Engine selected by the Docker CLI without requiring a context
name. Copy `.env.example` to `.env.local` and set `PARKBENCH_DOCKER_SOCKET_PATH`
to the Engine host's socket path if it differs from `/var/run/docker.sock`.
Set the three optional CPU-set variables to explicit, non-overlapping CPU IDs
or ranges to isolate the platform, PAS instances, and database. Then set local
references to the approved OpenEdge images, seed,
application archive, and credential reference. When running the control plane in
Docker, set `PARKBENCH_HOST_DATA_ROOT` and
`PARKBENCH_DOCKER_HOST_PATH_ROOT` to the same absolute host directory. Never
place credential values in the repository. Licensed OpenEdge deployments must
also set `PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE` to the approved OpenEdge
batch launcher available in the observer image/runtime. Optionally set
`PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE` to the approved read-only ABL/VST
procedure and `PARKBENCH_OPENEDGE_DB_OBSERVER_RUNTIME_PATH` to the host path
containing the licensed runtime. The launcher executes the procedure directly,
returns typed numeric metrics, and is never invoked through a shell or HTTP
fallback.

When `.env.local`, the imported Progress DB/PASOE and JDK images, the licensed
Progress inputs, and the compiler adapter are configured but generated
ParkBench images and artifacts are absent, bootstrap the complete local
platform with:

```bash
./scripts/bootstrap.sh
```

Bootstrap runs host and licensed-input preflight before `npm ci`, then installs
locked dependencies, builds application assets before dependent images, builds
both OpenEdge stages, loads the final generated runtime image references,
builds the platform support images, starts Compose, and waits for all six
required services: control plane, web UI, Prometheus, Grafana, cAdvisor, and
node exporter. It writes `.parkbench/host-environment.json`, the latest
`.parkbench/bootstrap-readiness.json`, and a redacted attempt log under
`.parkbench/bootstrap/`. Inspect `diagnosticLog` and `recoveryAction` in the
readiness JSON after a failure, then correct the named setting or local input
and rerun bootstrap. The script retains the concise `valid` and `error` fields
for existing command consumers.
The `PARKBENCH_OPENEDGE_DB_BASE_IMAGE` and
`PARKBENCH_OPENEDGE_PAS_BASE_IMAGE` settings identify the imported inputs;
`PARKBENCH_OPENEDGE_DB_IMAGE` and `PARKBENCH_OPENEDGE_PAS_IMAGE` identify the
ParkBench images used after the build.

Build the two-stage OpenEdge images before a live run. A compatible JDK image
must already be imported; the builder fails closed if it is absent. The generic
stage needs no seed; the final stage compiles the workloads against a copy of
the default seed database:

```bash
npm run openedge:build-generic
npm run openedge:build -- --image-stage final
```

### Seed databases

Runs start from a seed: a folder under `PARKBENCH_DISCOVERY_SEEDS_ROOT` that
holds one Linux OpenEdge database (`<db>.db`, a `<db>.st` with relative `.`
extent paths, and its extents, plus an optional `startup.pf`). The database name
is the `.db` file's name. The folder may hold nothing else, because every run
copies all of it into a fresh run-owned volume; the seed itself is mounted
read-only. Folders under the seeds root that hold other files (licenses, logs,
spool folders) are listed in the catalog as not ready.

On this host the seeds root is `/mnt/d/Projects/PUG/BenchmarkDb` and the default
seed is `one_gb_lnx`:

```bash
PARKBENCH_DISCOVERY_SEEDS_ROOT=/mnt/d/Projects/PUG/BenchmarkDb
PARKBENCH_OPENEDGE_DEFAULT_SEED=one_gb_lnx
```

ParkBench does not create seeds. OpenEdge database files cannot be moved between
operating systems, so a database built on Windows is converted once, outside the
platform, with a binary dump from the Windows OpenEdge install and a load into
a new database in the Linux DB image. `one_gb_lnx` was made that way from
`one_gb_win`. If a copy of a 1 GB seed on `/mnt/<drive>` pushes run readiness
past five minutes, move the seed folder to the WSL ext4 filesystem and point
`PARKBENCH_DISCOVERY_SEEDS_ROOT` at it.

Hosts that ran ParkBench before feature 014 remove the old sample-database
inputs once with `npm run openedge:migrate-sports2020` (use `--dry-run` first);
run history is kept.

The generic PASOE image is an intermediate runner and reports
`parkBenchReady=false`. The final root manifest/image env are the only valid
ParkBench inputs and include the complete `oepas1.zip`, workload list, and build timing. See [openedge-image-build.md](./openedge-image-build.md).

```bash
npm ci
npm run build
npm test
npm run smoke:fake
./scripts/compose.sh up -d
```

Build the run support images once after `npm run build`:

```bash
./scripts/compose.sh --profile build build loadgen-image observer-image
```

The local platform publishes the web UI on port 13002, the control-plane API
on 13000, Grafana on 13001, cAdvisor's web UI on 18080, and Prometheus on
19090 by default. Override the host ports with `PARKBENCH_*_HOST_PORT` in
`.env.local`; `scripts/start.sh` and `scripts/status.sh` print the actual
endpoints.

The example and local environment files are divided into commented sections for
host bindings, storage, observability, platform images, discovery roots,
loadgen/observer images, private OpenEdge inputs, OpenEdge build inputs, and
runtime defaults. ParkBench-owned npm commands and helper scripts automatically
load `.env.local` from the repository root. Use `./scripts/compose.sh` for
other Compose actions; it passes the selected environment file and Docker
target and resolves relative host paths from the repository root. Paths mounted
into the control plane must be below `PARKBENCH_DOCKER_HOST_PATH_ROOT`; that
host directory appears in the container at `/var/lib/parkbench`.

Open `http://127.0.0.1:13002/` and begin on the Overview screen. Use Catalog to
refresh Docker and managed-root discovery, Schedule to preview and confirm a
matrix, Queue to start, monitor, or cancel nonterminal work, and History/Comparison to review
retained evidence. Comparison does not require a fixed baseline: select any
eligible completed run after execution, or leave the baseline empty for a
descriptive-only review.

An OpenEdge seed may include a plain-text `db/startup.pf` in its seed
directory. The file is optional. Put supported
database broker settings such as `-B 500` in it, then select the seed in
Schedule. Remove both default parameter dimensions to create one run that uses
the file alone. The preview shows the effective value and its source. When
the same parameter appears in several places, a queued value wins over the
scenario value, which wins over `startup.pf`; the database default applies when
none is specified. A changed seed or `startup.pf` after preview requires a
fresh preview. Invalid or unsupported broker settings stop queueing with a
named error.

Each run checks its explicit broker settings against the primary database
before measurement. The saved `db-parameter-snapshot.json` records one
`_DbParams` reading and every parameter whose current value is nondefault,
including its exact text value, attempt time, and available observation time.
The run also publishes these values as run-scoped Prometheus metrics, and
verifies they are in Prometheus before it finalizes. Known values are stored and shown
in plaintext in the preview, run evidence, Prometheus, and Grafana; avoid
placing credentials in database parameter values. Open **Database startup
parameter snapshots** in Grafana to compare runs in a table. The **Open
Grafana** button beside each embedded dashboard opens the same selection and
time range in a new tab. Dashboards change only when you select one manually.
The former Bootstrap Web UI tab is gone; use `./scripts/bootstrap.sh` for
platform setup.

The fixture-backed browser suite covers the main UI workflows without Docker,
licensed inputs, or a running ParkBench stack. It exercises ready and unready
asset selection, scenario editing, scheduling, queue actions, run monitoring,
comparison/dashboard navigation, history evidence, and recovery from service
errors. Run it with:

```bash
scripts/test.sh browser
```

Playwright Chromium must be installed in the local environment
(`npx playwright install chromium`).

The platform creates the shared `parkbench-platform` metrics network. Per-run
Compose projects attach only their metrics endpoints to that network; database
and PAS services remain on their run-private network. The control plane maps
generated bind mounts through the host path variables so the Docker daemon can
access files created inside the control-plane container.

The fake smoke run validates scenarios, creates a two-cell matrix, walks the
run lifecycle, captures workload/native/resource/file metrics, verifies the run's series
are queryable in Prometheus before cleanup, and verifies
that threshold failures and incomplete cells do not stop later cells. The
terminal-path integration suite covers succeeded, threshold-failed, failed,
cancelled, incomplete, and interrupted runs.

For a licensed command-line smoke test, load the generated root `images.env`
into `.env.local`, select `examples/scenarios/parkbench-bank-mix.json`, then
run:

```bash
npm run preflight -- --config .env.local --scenario examples/scenarios/parkbench-bank-mix.json
npm run smoke:openedge -- --config .env.local --scenario examples/scenarios/parkbench-bank-mix.json
```

The licensed browser acceptance exercises the deployed web UI end to end. It
requires `.env.local` with the private OpenEdge license and Progress runtime,
the default seed (`PARKBENCH_OPENEDGE_DEFAULT_SEED`), application archive, final ready
ParkBench DB/PAS and observer/load-generator images, a healthy Compose profile,
required disk-I/O sources, and installed Playwright Chromium. Start the
configured deployment and run:

```bash
npm run test:browser:licensed
```

The command runs a redacted licensed preflight before opening the browser. The
Playwright test uses the real UI and deployed API, schedules three runs of the
ParkBench scenario against the default seed, verifies retained evidence and metric export,
and checks that run-owned resources were cleaned up. The test rejects `PARKBENCH_SMOKE_SKIP_DISK_IO` and
fails with a nonzero exit when any private input, required service, disk-I/O
source, or browser prerequisite is missing; it never converts an unmet licensed
acceptance requirement into a skipped test. The run evidence is retained at
`${PARKBENCH_ARTIFACT_ROOT}/<run-id>/run-evidence.json`.

On Docker Desktop/WSL, per-container cAdvisor block-I/O series may not be
available even when cAdvisor is healthy. To validate the images, workload, and
ParkBench lifecycle locally while preserving the production disk-I/O gate, use
the smoke-only opt-out:

```bash
PARKBENCH_SMOKE_SKIP_DISK_IO=1 npm run smoke:openedge -- \
  --config .env.local \
  --scenario examples/scenarios/parkbench-bank-mix.json
```

This opt-out does not claim disk-I/O completeness and does not satisfy feature
acceptance. Run the command without the opt-out against the configured Docker Engine;
missing required disk-I/O evidence remains an acceptance failure.

The scenario sends one compact JSON input to the runner's `POST /work` handler.
For the PASOE WEB transport the full URL is
`http://pas:8810/parkbench/web/work`; the operation path remains `/work`. A
timeout or no-response at 60000 milliseconds stops further load and marks the
owning run `FAILED`. Its observed duration is retained as a lower bound of at
least one minute, excluded from completed latency percentiles, and exported
before cleanup.

`npm run preflight` is the same fail-closed gate used by the API: it requires
valid explicit image tags other than `latest` for the database, PAS, loadgen,
and observer images. The configured image reference is used as supplied. The gate also verifies the configured
observer declarations and readiness contract, checks Docker/Prometheus health
and disk-I/O sources. The command does not create
run resources.
