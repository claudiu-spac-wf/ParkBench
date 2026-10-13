# OpenEdge image build inputs

The OpenEdge builder consumes locally supplied Progress assets, a licensed
`progress.cfg`, an imported compatible JDK image and, for the final stage, the
seed database the workloads compile against. It writes all
generated archives, manifests, logs, and staging data below
`.parkbench/openedge/`, which is intentionally ignored by Git.

Seeds are Linux OpenEdge database folders already on disk under
`PARKBENCH_DISCOVERY_SEEDS_ROOT` (for example `BenchmarkDb/one_gb_lnx`). Keep
them outside source control. Each benchmark copies the selected
seed into a fresh run-owned database volume; the seed is mounted read-only and
never used as the writable run database.

The build has two stages:

- `generic` builds the reusable database, runner, and observer images. It needs
  no seed. Its PASOE image is explicitly not a ParkBench workload input.
- `final` discovers and validates procedures (and their `*.contract.json`)
  below `openedge/workloads/Workloads`, compiles them against the compile
  seed database, packages the complete `oepas1.zip`, and
  rebuilds only the PASOE image as the ParkBench-ready output.

Use `npm run openedge:preflight -- --help` and
`npm run openedge:build -- --help` for the supported command-line options.

Example with private inputs already configured in `.env.local`:

```bash
npm run openedge:preflight
npm run openedge:build
PARKBENCH_RUN_OPENEDGE_TESTS=1 npm run smoke:openedge -- \
  --config .env.local \
  --scenario examples/scenarios/parkbench-bank-mix.json
```

To measure database-observer overhead, run paired mode. It keeps the ParkBench
scenario, images, seed, effective settings, and load seed aligned; only the
database metrics collection toggle changes:

```bash
PARKBENCH_RUN_OPENEDGE_TESTS=1 npm run smoke:openedge -- \
  --measure-observer-overhead \
  --config .env.local \
  --scenario examples/scenarios/parkbench-bank-mix.json
```

The live smoke requires the licensed database/PAS images, credentials, runner
archive, and the default seed. Contract and fixture tests do not require
those inputs. The checked-in OpenEdge 12.8 compatibility matrix distinguishes
synthetic contract-shape fixtures from live patch evidence; a fixture does not
claim that a patch was exercised. For each local patch, point
`PARKBENCH_OPENEDGE_LIVE_CONFIG_12_8_11` (replace the suffix with the patch) to
that patch's private environment file. The live integration test records
supplied patches separately from releases whose licensed image, license, or
seed was unavailable. Record the exact configured image reference,
`_DbStatus` product patch/build, and per-measurement availability in live evidence.

Grafana provisions the overview plus host resources, platform resources, PAS
instances, database resources, database activity, and database
recovery/concurrency dashboards. Use the `run_id` and `phase` selectors on each
dashboard; the PAS dashboard also has a `replica` selector. Database VST
panels preserve explicit availability states, so missing measurements are not
displayed as measured zeroes.

Paired evidence is written into both run-evidence files and includes observer
collection duration, observer CPU and peak memory, workload throughput, and
latency percentiles. Review `observerOverhead.mode` and `pairedRunId` on each
evidence file; these measurements have no fixed pass/fail ceiling.

Do not copy licenses, Progress archives, JDK layers, or generated image output
into tracked files.

### Readable observer artifacts

Feature 017 stages `parkbench-db-observer-v2.p` and freshly compiled `parkbench-db-observer-v2.r` in the observer context. `compile-source.p` prepares a schema-specific source with 14 explicit `PB_HAS_*` flags; it keeps optional-field checks inside the dedicated collectors. `compile-with-db.mjs` clears its named stale r-code and requires fresh output. Owned profile directories and compiler containers are cleaned.

Build generic before final, or use `--image-stage all`. Final checks generic collector source identity to prevent reusing pre-feature artifacts. Generated `images.env` uses the compiled v2 path. Protocol remains 3; filename v2 is an implementation version. Raw launches instead use the fixed packaged `prepare-run-db-observer.p`, never a caller-selected source. See `docs/validation/readable-db-observer.md` for native compilation/equality evidence and patch limits.
