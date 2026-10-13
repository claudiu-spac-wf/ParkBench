# Docker, environment, and path audit validation

Validation was run from the ParkBench repository on 2026-09-23. The test
fixtures used temporary files and fake Docker commands; no licensed OpenEdge
inputs were read or copied into the repository.

## Automated checks

| Check                      | Result                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| `npm run test:contract`    | Passed: 98 tests                                                               |
| `npm run test:integration` | Passed: 111 tests; 4 licensed/live-Docker tests skipped by their prerequisites |
| `npm run test:security`    | Passed: 18 tests                                                               |
| `npm run typecheck`        | Passed                                                                         |
| `npm run lint`             | Passed                                                                         |
| `npm run format:check`     | Passed                                                                         |

The integration coverage exercised root and alternate working directories,
selected environment files, process-over-file precedence, Engine ID
consistency without context-name checks, repository-relative paths, symlink
boundaries, generated input handoff, CPU affinity, and storage write locations. The generated seed, application archive,
and image manifest were mapped to `/var/lib/parkbench`; an input outside the
mounted Docker host root was rejected without exposing its path.

The follow-up bootstrap handoff regression run explicitly cleared the three
CPU-set variables in the test process so operator affinity assignments could
not affect unrelated deterministic contract cases. The new cases confirm that
generated `images.env` assignments supersede inherited image/path values and
that ordinary operator configuration keeps process-over-file precedence.

## Resolved Compose model

The real Docker Compose CLI rendered the model through
`./scripts/compose.sh config --format json` from both the ParkBench root and a
temporary alternate directory. The temporary profile used `.env.example` as a
base, filled its required JDK image with the harmless `parkbench/jdk:local`
reference, and set temporary data and Prometheus target directories containing
spaces. Assertions confirmed:

- the selected environment file is mounted read-only at
  `/app/config/operator.env`;
- the host data directory is mounted at `/var/lib/parkbench`;
- seed, archive, and manifest paths use the control-plane namespace;
- the configured Prometheus retention reaches the Prometheus command;
- the same configured target directory is mounted into Prometheus and the
  control plane.

This check parsed configuration only. It did not build or start containers.
Its temporary environment file and directories were removed after the check.

## Remaining external check

The feature's deterministic acceptance checks pass without private inputs. A
live platform readiness run and the licensed OpenEdge smoke test still require
the operator's selected Ubuntu/Linux Engine, imported images, compiler
adapter, and local licensed inputs. Those gated checks were skipped because
they were not part of this fixture validation.

## Corrective Docker target and resource configuration

Host preflight and runtime management no longer run `docker context` commands
or gate on a context label or systemd service state. The operator-selected Docker Engine
still detects an Engine change between preflight and runtime. The control-plane
socket bind uses `PARKBENCH_DOCKER_SOCKET_PATH` from the selected environment
file and resolves relative values from the repository root.

`PARKBENCH_PLATFORM_CPUSET`, `PARKBENCH_PAS_CPUSET`, and
`PARKBENCH_DB_CPUSET` accept CPU IDs and ranges. Tests reject malformed or
overlapping groups, and generated run services assign platform CPUs to load
generation/observers, PAS CPUs to each PAS target, and DB CPUs to the database.
The real Compose CLI parsed the persistent platform model with all CPU sets
configured and confirmed both default and custom socket bind sources,
including a custom path containing spaces. It also parsed a generated run
Compose model and confirmed the configured IDs on DB, PAS, and support services.
With CPU-set values empty, Compose omits the affinity property and leaves
containers unpinned.

## cAdvisor web UI host port

`PARKBENCH_CADVISOR_HOST_PORT=18080` is set in the local operator profile and
publishes cAdvisor's internal port 8080 on loopback. The config-aware Compose
check passed, host preflight reported `port_cadvisor` available, and the status
command reported `http://127.0.0.1:18080`. The start script's endpoint
regression passed. After recreating only the cAdvisor service, requesting that
URL while following its redirect returned HTTP 200.

## Prometheus cAdvisor metrics

The original `cadvisor` target was healthy but scraped the control-plane proxy,
which intentionally returns no series when there is no active run. A direct
query for cAdvisor CPU and filesystem metrics therefore returned no results
while idle. Prometheus now also scrapes `cadvisor:8080` directly for containers
in the persistent `parkbench-platform` Compose project as the `cadvisor` job,
and drops run-managed containers from that scrape. The proxy target is now
named `parkbench-run-cadvisor` and remains run-scoped, so run-owned series are
not duplicated or mixed with unrelated Compose projects.

`promtool check config` passed. After recreating only Prometheus, both cAdvisor
targets reported `up=1`. PromQL queries returned persistent container CPU
series for all six platform services and filesystem read series for five
services. No benchmark run was active during this live check; the
`convergence-metrics` tests pass the active-run filter and ownership-label
contract for run-owned metrics.
