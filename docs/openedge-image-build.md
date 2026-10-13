# OpenEdge image build

The builder consumes the imported Progress database/PASOE images, a compatible
local JDK image, `../IMAGES`, and the private `../progress.cfg`. It never
downloads or records license contents. Generated contexts, archives, image
logs, and manifests are stored below `.parkbench/openedge/`.

For the Ubuntu migration profile, use native Ubuntu 26.04.1 LTS on x86_64 with
Node.js 24 or later and the local Linux Docker Engine. Run
`node scripts/host-preflight.mjs` and
`npm run openedge:preflight -- --image-stage all` before installing
dependencies or starting builds. Preflight checks the configured compiler
adapter's execute permission before the final image stage. If the adapter does
not return a safe `--version` value, the host profile records a warning and
continues.

The archives can also be created independently of an image build:

```bash
npm run openedge:create-runner-archive
```

Use `--output-root`, `--stage`, and `--workload-root` to override the runner
archive defaults; the result is `oepas1.zip` below the selected output root.
Seeds are Linux OpenEdge database folders already on disk under
`PARKBENCH_DISCOVERY_SEEDS_ROOT`; the build does not create them. The DB image
carries no seed.

Run the generic stage first when diagnosing image plumbing:

```bash
npm run openedge:preflight -- --image-stage generic
npm run openedge:build -- --image-stage generic
```

The generic manifest is under
`.parkbench/openedge/stages/generic/manifest.json` and must report
`parkBenchReady=false`. It is not a ParkBench workload input. The final stage
discovers procedures under `openedge/workloads/Workloads`, validates their
single `LONGCHAR` signature, compiles them with the executable configured in
`PARKBENCH_OPENEDGE_COMPILER`, creates the complete `oepas1.zip`, and rebuilds
only PASOE. The final stage fails closed if a compiler is not configured:

The repository supplies a compiler adapter that starts the explicitly tagged
generic DB image with a fresh empty UTF-8 database loaded from the matching
`PARKBENCH_OPENEDGE_COMPILE_SCHEMA` definition file. Storage areas keep their
schema names with minimal empty extents. The VST-only observer uses an empty
database without application definitions. The adapter waits
for its broker, and invokes `pro` with an ABL
`COMPILE ... SAVE` driver. It emits the corresponding `.r` file beside the
source while keeping the compiler and license inside the temporary database
container. Configure it on Linux with:

```bash
export PARKBENCH_OPENEDGE_COMPILER="$PWD/scripts/openedge/compile-with-db.mjs"
chmod +x "$PARKBENCH_OPENEDGE_COMPILER"
```

On native Windows Node, use the supplied command launcher instead:

```powershell
$env:PARKBENCH_OPENEDGE_COMPILER = "$PWD/scripts/openedge/compile-with-db.cmd"
```

When native Windows Node is launched from a WSL shell whose Docker Desktop
endpoint is exposed as `docker.exe`, also set
`PARKBENCH_OPENEDGE_DOCKER_COMMAND=docker.exe`. A Linux Node/Docker setup can
use the default `docker` command.

The final image builder passes the exact generic-stage DB image reference to
this adapter together with the `.df` file configured in
`PARKBENCH_OPENEDGE_COMPILE_SCHEMA`. Set it to the definition file used to create
the run seed, for example `../ParkBenchDB/db/parkbench.df`. The final manifest
(`image-build.v2`) records the reference seed name and definition-file SHA-256
as `compileSchema`. No seed extent is mounted or copied during compilation. An explicit non-`latest` tag is required. The temporary compiler
container is shared by all workload files and the handler for the build, then
removed with its database volume. The supplied adapter accepts `--batch` plus
source paths; custom adapters retain the original per-file interface.

```bash
npm run openedge:build -- --image-stage final
```

Use `--image-stage all` to run both stages in order. Only the root
`.parkbench/openedge/manifest.json` and `images.env` are final outputs. Every DB, PASOE, observer, and JDK reference is recorded as configured; `latest` references are rejected. The final manifest includes archive paths, stage and readiness flags, and generic-to-final total duration.

Bootstrap retains redacted image logs under `.parkbench/openedge/images/` and
emits the failed stage, component, relative attempt log, and recovery action in
`.parkbench/bootstrap-readiness.json`. For the original generic observer
failure, inspect `.parkbench/openedge/images/generic-observer.log`; the generated
observer context includes the shared environment loader required by its
Dockerfile. Correct local image or configuration issues and rerun. The builder
uses unique owned staging directories and preserves unowned final outputs and
prior run evidence.

Bootstrap reports ready only after the control plane, web UI, Prometheus,
Grafana, cAdvisor, and node exporter all pass their health probes. The licensed
smoke remains a separate acceptance step and requires the private inputs and
complete disk-I/O evidence.

The runtime database is the selected seed's database (for ParkBenchDB seeds,
`parkbench`); PAS receives its connection at start through
`PARKBENCH_PAS_DB_CONNECTION`. Broker `20931` with dynamic ports `20932-20941`, PAS instance
`oepas1`, HTTP `8810`, `/psc/wrk`, and `collectMetrics=3`.

## Feature 017 collector rebuild

Run `npm run openedge:preflight -- --image-stage all` and `npm run openedge:build -- --image-stage all` with the supplied licensed inputs. Generic creates the DB image, then profiles/compiles `parkbench-db-observer-v2.p` against that schema and packages fresh `parkbench-db-observer-v2.r`. The compiler adapter removes stale output before compilation and rejects missing output. Workload compilation follows its existing schema workflow.

A final-only build reuses generic observer artifacts. Rebuild generic first: final verifies the generic image's exact v2 procedure label and source SHA, and rejects older/stale collector artifacts. Generated `images.env` selects `/app/openedge/observers/db/parkbench-db-observer-v2.r`. Public `image-build.v2`, protocol 3, `all_tables` and capture.v1 contracts stay unchanged. Refresh generated configuration using the existing operator workflow; an explicit old-procedure setting takes precedence and must be reconciled separately.

The generic raw observer image packages the fixed preparation procedure and v2 source. Its default profiles the connected runtime schema per invocation, produces UUID-scoped temporary source/r-code and cleans both on success/failure. Runtime and compiled schemas must match. No compilation failure falls back to the old observer. Native evidence is reported in `docs/validation/readable-db-observer.md`; unexercised patches remain unverified.
