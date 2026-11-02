# Experiment database setup

On **Schedule**, use **Database setup** to add an operation, then add its settings. Steps run in displayed order; all settings within a step run in displayed order. Reorder or remove either level. Removing the last settings removes its step. Separate instances of the same operation are also supported. Every nested edit invalidates the preview. Review the complete sequence before confirming.

Setup is static across an experiment. Two parameter combinations and two repetitions still produce four runs; each fresh run gets the same sequence and its own copied database. Omitting setup retains the existing startup flow.

## Supplied operations

- **Rebuild indexes**: offline `proutil <db> -C idxbuild`, with all, table, or selected-index scopes. Table scope accepts owner-qualified names. The OpenEdge 12.8 Some dialogue uses native unqualified table names and index names; it does not accept owner-qualified table names in that prompt. ParkBench sends a finite transcript, retains rejected-target diagnostics, and fails instead of accepting a partial requested scope. It never substitutes a broader rebuild.
- **Compact index**: offline `proutil <db> -C idxcompact` with a fully qualified index. Omit utilization to retain the native default of 80, choose 50–100, or choose unused-blocks mode. The percentage and unused-blocks mode are mutually exclusive.
- **Reorganize tables**: `proutil <db> -C tablereorg` with an owner-qualified Type II table and optional active, non-word ordering index. Omit the index to retain the native primary-index default. All settings in one step share one temporary broker; a separate step gets a separate complete broker cycle.

Additional native arguments are literal tokens. Quotes group words; no host expansion occurs. Invalid native options/targets retain their utility errors. UTF-8 internal code page is supplied. See the Progress 12.8 [IDXBUILD](https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-IDXBUILD-qualifier.html), [IDXCOMPACT](https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-IDXCOMPACT-qualifier.html), and [TABLEREORG](https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-TABLEREORG-qualifier.html) references for utility-specific restrictions.

## Custom shell scripts

Direct-host configuration uses `PARKBENCH_DISCOVERY_SCRIPTS_ROOT`, default `.parkbench/scripts`. Put readable regular `.sh` files there, including nested folders, then choose **Custom shell script** and refresh the files. Sources need not be executable. Contained symlinks are resolved; paths escaping the real root are rejected. Script discovery has its own endpoint and does not add a Catalog category.

For the platform Compose deployment, set `PARKBENCH_HOST_DISCOVERY_SCRIPTS_ROOT` to the host folder. It is bound read-only at `/var/lib/parkbench/scripts` in the control plane. Keep the existing artifact-root Docker host mapping configured: only selected files are staged into attempt-owned inputs for the DB container. Source permissions and contents remain unchanged. A source edited after preview is captured at provisioning without a content-equality check. A missing source fails the run with its reviewed options retained.

Each custom settings entry has one **Script input** field. Empty text invokes the script without arguments. Text is retained without trimming, parsing, content validation or a new length restriction. The generated container command is the quoted selected script name followed by the exact suffix. Quotes, expansions, pipelines, trailing commands, whitespace and newlines have their usual container-shell behavior. It executes from the copied database directory, normally `/psc/wrk/<database-name>`.

Success requires an observed zero exit from both the selected script and the surrounding shell, plus confirmed completion of their process scope. `script.sh fail | cat` or `script.sh fail; true` cannot hide a selected-script failure. Errors deliberately handled inside the script are judged through its final status. Detached/reparented work keeps setup in **Waiting for background processes**, with cancellation available. No later settings or normal broker start until quiescence. There is no new utility-duration timeout.

## Startup, failure and evidence

Rebuild the DB image through the existing OpenEdge image build before using setup. The image advertises `database-setup.v1`; unsupported images fail explicitly. A small Linux child subreaper is compiled in a DB-base build stage. The final image contains its executable, without a compiler or C source. Linux subreaper/pidfd capability is checked before custom work.

The controller persists resource ownership intent before Docker creation and initially starts only the DB container. The entrypoint claims a single-use attempt fence before seed copy, repair or BI preparation. It copies/prepares once, preserves the existing BI safeguards, and executes utilities serially on the same modified copy.

TABLEREORG temporarily uses `proserve`, waits for native readiness, runs its settings, then uses `proshut -by` and confirms offline state/process exit. Benchmark writers, PAS, observers and schema clients do not start during this lifetime. After successful setup, the database stays offline until an attempt-specific controller release. The normal broker then starts with the reviewed benchmark settings on the modified copy. This separates broker lifetimes and counters; it does not reset the OS page cache.

A failed setting stops later settings, which appear as **NOT_EXECUTED**. Active/detail and History show the current phase, ordered outcomes, separate selected-script/shell exits, process state, temporary startup/shutdown results and retained log downloads. Configuration and evidence survive input/control scratch deletion. GET `/api/v1/runs/<runId>/database-setup` returns the same retained evidence; old runs return NOT_REQUESTED.

Cancellation before release prevents normal startup. Recovery interrupts and cleans owned resources without rediscovering scripts, replaying utilities or releasing the startup barrier. An unconfirmed process scope/shutdown keeps cleanup uncertain until owned deletion is verified. Retrying requires fresh run-owned database state; restarting the same attempt is refused before mutation.

## Validation

### Recovering an older database image

`database_setup_unavailable` before any utility starts can mean the selected database image predates setup support. Updating the control plane and web images does not rebuild the OpenEdge database image. Inspect the exact database image selected for the run:

```bash
docker image inspect parkbench/openedge-db:dev \
  --format '{{index .Config.Labels "org.parkbench.database-setup"}}'
```

Replace that reference with your configured image if different. The result must be `database-setup.v1`. Rebuild the OpenEdge images with the current checkout and configured licensed inputs (`npm run openedge:build-generic`, followed by `npm run openedge:build -- --image-stage final`), then schedule a new experiment. The failed run remains historical evidence; restarting its setup attempt is refused. Rebuilding only the web/control plane or adding a label to an old image does not install the required native helpers.

After setup succeeds, normal startup still checks connection capacity. If it reports `database_writer_capacity_insufficient`, configure sufficient `-n` capacity in the experiment's database startup parameters. For example, the 35-client read workload requires 38 connections plus any requested APW/BIW slots; an explicit `-n=100` accommodates that workload. Setup does not change the seed's startup file or silently increase the reviewed benchmark settings.

Ordinary fixture and browser checks need no licensed seed. Native checks require the licensed 12.8.11 image built with the new helpers. Create the validation-only detached-process fixture image:

```bash
docker build -f tests/fixtures/database-setup/native/Dockerfile \
  --build-arg DB_IMAGE=parkbench/openedge-db:dev \
  -t parkbench/openedge-db:setup-validation .
PARKBENCH_RUN_OPENEDGE_TESTS=1 \
PARKBENCH_DATABASE_SETUP_TEST_IMAGE=parkbench/openedge-db:setup-validation \
  node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 \
  tests/integration/openedge-database-setup-utilities-live.test.ts \
  tests/integration/openedge-database-setup-live.test.ts
```

The validation image alone adds a public double-fork helper for acceptance; production images do not include it. Tests create synthetic databases in labelled `parkbench-f023-*` resources and retain transcripts/cleanup proof under `.parkbench/validation/feature023/`. Explicit native opt-in with missing prerequisites fails. Disabled native tests do not establish acceptance.
