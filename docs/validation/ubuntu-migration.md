# Ubuntu migration validation

**Reviewed:** 2026-09-23
**Target:** Ubuntu 26.04.1 LTS (`resolute`), x86_64 host using the Linux Docker
Engine selected by the Docker CLI. No Docker context name or systemd service
state is required. Node.js 24 or later is required.
npm, Docker CLI, Docker Engine, Docker Desktop, and Compose versions are
recorded as observed values without exact-version gates.

## Issue impact and disposition

| Issue                                                                                                                                                                                          | Impact                                                                                                              | Disposition                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic observer build returned `docker_build_failed:generic-observer` because its generated context omitted `scripts/lib/load-env.cjs`.                                                       | Prevented the OpenEdge image build before platform startup.                                                         | Fixed by staging the shared environment loader at the exact Dockerfile `COPY` path; a contract check inspects every non-base `COPY` source in the generated context. A live Docker build still requires the imported licensed images.                                                                             |
| The repository compiler adapter was tracked without its executable Git mode.                                                                                                                   | Direct execution fails on a clean Linux checkout.                                                                   | Fixed by tracking `scripts/openedge/compile-with-db.mjs` as executable and checking Linux modes for the bootstrap/build/start/compiler entry points.                                                                                                                                                              |
| Setup previously reached dependency/build work before confirming the host and effective npm registry.                                                                                          | Host, Engine, path, port, disk, and private-input problems appeared late and could leave partial outputs.           | Fixed with a dependency-free host preflight and OpenEdge input preflight before `npm ci`; failures produce stable codes and recovery actions.                                                                                                                                                                     |
| Run metadata described the Node/container context without an Ubuntu and Docker Engine profile.                                                                                      | Results could be confused with prior Windows/WSL runs.                                                              | Fixed additively under `run-evidence.v1` → `hostDocker.hostEnvironment`, including profile version, capture time and host facts, and observed Engine OS/architecture/version.                                                                                                                              |
| Docker Desktop and a separate system Docker Engine were both present during the previous host inspection; their image stores differed and the system Engine had its own cAdvisor on port 8080. | Selecting another Engine can expose different images, containers, and host ports.                                   | ParkBench now follows the operator-selected Docker CLI target and uses the operator-selected Docker CLI target across workflow stages. It does not query context names or gate on systemd service state; operators should choose the Engine that contains the required images. No image references or licensed contents are recorded here. |
| The earlier missing-image result came from checking an Engine whose image store did not contain the configured references.                                                                     | Bootstrap could report a private base image missing even though it existed on another installed Engine.             | Fixed by using the operator-selected Engine without an identity comparison, without requiring a specific context name.                                                                                                                                                                                  |
| Licensed OpenEdge acceptance smoke has not run in this environment.                                                                                                                            | Full feature acceptance is not established until baseline and variant runs succeed with complete disk-I/O evidence. | Pending Docker Desktop preflight, bootstrap readiness, and the supplied licensed inputs. Run `npm run smoke:openedge` after all six services report ready; do not disable disk-I/O checks for acceptance.                                                                                                         |

The previous host inspection found Docker Desktop 4.92.0 and Docker Engine CE
29.8.1 installed, with separate image stores and an independent cAdvisor
container on port 8080. Those observations explain the original mismatch but
are not acceptance requirements. Bootstrap and image inspection now use the
Docker CLI's selected target; the operator must select the Engine that has the
configured images and available ports.

The former `docker_context` and `standalone_engine_inactive` gates have been
removed. Preflight now requires an accessible Linux/amd64 Docker Engine and
records the selected Engine metadata without storing or comparing its ID. Set `PARKBENCH_DOCKER_SOCKET_PATH` in `.env.local` if the
control plane must mount a non-default host socket. Optional CPU-set settings
pin platform helpers, PAS targets, and the DB to non-overlapping CPU IDs.

Validate Compose configuration through the repository wrapper with
`./scripts/compose.sh config --quiet`. It loads the selected environment file,
resolves the project file and host paths, and then runs the Compose config probe.

## Supported setup sequence

Configure `.env.local` with local settings and private-input references. Keep
licensed files, private archives, credentials, and local image exports outside
Git. Then run:

```bash
node scripts/host-preflight.mjs
npm run openedge:preflight -- --image-stage all
./scripts/bootstrap.sh
```

Bootstrap repeats preflight so it remains safe as a single documented command.
It installs locked dependencies, builds the app before its dependent image,
builds the generic and final OpenEdge images, builds the load generator and
observer support images, starts Compose, and waits for readiness.

Read `.parkbench/bootstrap-readiness.json`. `valid` is true only when these six
services are all `ready`:

- control plane
- web UI
- Prometheus
- Grafana
- cAdvisor
- node exporter

The report names the failed stage and component, points to a relative redacted
diagnostic log, and gives a recovery action. The host profile is retained at
`.parkbench/host-environment.json`. Correct the named setting or local input
and rerun bootstrap. Keep `.env.local`, existing run evidence, and unrelated
containers, images, and volumes in place.

After readiness succeeds, source the generated image references and run the
licensed acceptance smoke:

```bash
set -a
source .parkbench/openedge/images.env
set +a
npm run smoke:openedge -- --config .env.local --scenario examples/scenarios/sports2020-workload.json
```

Do not set `PARKBENCH_SMOKE_SKIP_DISK_IO=1` for acceptance. Successful evidence
must include baseline and variant runs, readiness transitions, complete
observer and disk-I/O metrics, the raw Prometheus export, the recorded host
profile reference, and ownership-verified cleanup.

## Non-licensed verification

Results from the implementation run are recorded below. Browser verification
requires an installed Playwright Chromium binary. The licensed smoke is
separately gated and is not replaced by the fake smoke.

| Check                    | Command                                              | Result                                                                          |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Format                   | `npm run format:check`                               | PASS                                                                            |
| Lint                     | `npm run lint`                                       | PASS                                                                            |
| Typecheck                | `npm run typecheck`                                  | PASS                                                                            |
| Contract suite           | `npm run test:contract`                              | PASS: 90 passed                                                                 |
| Unit suite               | `npm run test:unit`                                  | PASS: 7 passed                                                                  |
| Integration suite        | `npm run test:integration`                           | PASS: 93 passed, 4 licensed/live cases skipped                                  |
| Security suite           | `npm run test:security`                              | PASS: 16 passed                                                                 |
| Browser suite            | `npm run test:browser`                               | PASS: 12 passed after installing Playwright Chromium                            |
| Fake smoke               | `npm run smoke:fake`                                 | PASS: comparative baseline/variant fake smoke succeeded                         |
| Private-input Git review | `git status --short` and tracked private-input check | PASS: no licensed input paths or `.env.local` are tracked or present in changes |

## Acceptance status

Platform readiness and licensed smoke acceptance remain pending stopping the
standalone system Engine and running the full bootstrap/smoke path with the
private OpenEdge inputs through Docker Desktop. Do not treat static/context
regression checks or fake smoke as a substitute for that live acceptance run.

## Bootstrap memory pressure and schema-only compilation

Final workload compilation uses `PARKBENCH_OPENEDGE_COMPILE_SCHEMA`, a `.df`
matching the run seed. It creates an empty UTF-8 database with minimal extents,
loads definitions and compiles against a small 1024-buffer cache. One compiler container is shared by all workloads and the handler, then removed.
It never mounts or copies benchmark seed data. Generic observer compilation remains schema-free.

Host preflight checks Linux `MemAvailable` and requires at least 2 GiB of host
headroom. This catches severe pressure but does not guarantee every Docker VM
allocation fits; the container memory cap also does not cap host VM helpers.
When `/tmp` is tmpfs, retained crash dumps consume RAM. Preserve inactive dumps
on a disk-backed filesystem before removing their RAM-backed copies.

On 2026-10-02, bootstrap failed in final compilation while copying the 28 GB seed.
The kernel killed Docker Desktop's QEMU process at about 11.6 GiB resident
memory while host swap was exhausted. Nineteen inactive user-owned crash dumps
occupied 14,797,881,344 bytes in RAM-backed `/tmp`. Hash-verified preservation
to `.parkbench/validation/feature019/bootstrap-oom/crash-dumps/` freed that RAM.
The failure was host OOM; the retained compiler container was not marked
`OOMKilled`. No concurrent experiments were involved in those bootstrap attempts.
