# ParkBench helper scripts

Run these commands from any directory; each script finds the repository root.

| Script                                   | Purpose                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `./scripts/setup.sh`                     | Install pinned npm dependencies and create `.env.local` if needed.              |
| `./scripts/bootstrap.sh`                 | Preflight Ubuntu and licensed inputs, build images, and start the platform.     |
| `./scripts/build.sh`                     | Build the control plane and production web UI.                                  |
| `./scripts/start.sh`                     | Build and start the local Docker Compose platform.                              |
| `./scripts/start.sh --build-images`      | Also build the loadgen and observer support images.                             |
| `./scripts/compose.sh [arguments...]`    | Run a Docker Compose action with ParkBench's selected config and Docker target. |
| `./scripts/status.sh`                    | Show Compose service status.                                                    |
| `./scripts/logs.sh [service]`            | Follow Compose logs.                                                            |
| `./scripts/stop.sh`                      | Stop the platform without removing volumes.                                     |
| `./scripts/test.sh [suite]`              | Run all, contract, unit, integration, security, UI, or browser tests.           |
| `./scripts/check.sh`                     | Run typecheck, lint, formatting, security, and all tests.                       |
| `./scripts/smoke.sh [fake\|openedge]`    | Run the fake or gated OpenEdge smoke test.                                      |
| `./scripts/preflight.sh`                 | Validate configured benchmark prerequisites.                                    |
| `./scripts/build-images.sh`              | Compile TypeScript, then build the loadgen and observer support images.           |
| `npm run openedge:create-runner-archive` | Create the `oepas1.zip` PAS runner archive.                                     |

All ParkBench helper scripts automatically load `.env.local` from the repository
root before they run. Set `PARKBENCH_ENV_FILE` in the invoking process to select
another profile; relative paths resolve from the repository root. Values in the
invoking process take precedence over values in that file, and conflict warnings
name the setting and sources without printing values. Use `scripts/compose.sh`
for a direct Compose action so it receives the same environment file, absolute
Compose file, repository working directory, and operator-selected Docker target.
The wrappers use `deploy/platform-compose.yml` by default. The default
local-only host ports are web UI `13002`, control plane `13000`, Grafana
`13001`, cAdvisor UI `18080`, and Prometheus `19090`. Override them with
`PARKBENCH_*_HOST_PORT` in `.env.local`; use `PARKBENCH_BIND_ADDRESS` only
when the UI must be reachable from another host. Override the Compose inputs
with `PARKBENCH_ENV_FILE` and `PARKBENCH_COMPOSE_FILE` when needed.

Relative host data, input, and output paths resolve from the repository root.
Compose mounts the host data root at `/var/lib/parkbench`; database, artifact,
and run paths inside the control-plane container are derived from that mount.
Prometheus retention is applied to its TSDB, and the configured target directory
is shared by the control plane and Prometheus at `/etc/prometheus/targets`.

`PARKBENCH_IMAGE_TAG` is the non-`latest` tag applied to images built by the
platform Compose file, OpenEdge image builder, and control-plane image
operations. Imported base images keep their own configured references.

The initial supported migration host is Ubuntu 26.04.1 LTS on x86_64. ParkBench
uses the Docker Engine selected by the CLI and does not require a named context
or inspect system service state. Set `PARKBENCH_DOCKER_SOCKET_PATH` in
`.env.local` if the Engine host socket differs from `/var/run/docker.sock`.
Optional platform, PAS, and database CPU sets accept actual CPU IDs and ranges,
such as `0-3`, `4,5`, and `6,7`; leave them empty for normal Docker scheduling.
Node.js 24 or later is required; Docker and Compose versions are observed
without exact-version gates. Use
`./scripts/bootstrap.sh` when `.env.local`, the imported OpenEdge base/JDK
images, licensed Progress inputs, and compiler adapter are ready. Bootstrap
checks host and input prerequisites before `npm ci`, builds application assets,
builds the generic and final OpenEdge stages, loads the generated final
`images.env`, builds the support images, starts Compose, and waits for the
control plane, web UI, Prometheus, Grafana, cAdvisor, and node exporter.

Inspect `.parkbench/host-environment.json` for sanitized host facts and
`.parkbench/bootstrap-readiness.json` for the latest status. The report retains
the failed lifecycle stage, component, relative diagnostic log, and recovery
action. Bootstrap also keeps a redacted attempt log below
`.parkbench/bootstrap/`. Correct the named host setting or private local input
and rerun; the workflow keeps `.env.local`, previous run evidence, and unrelated
Docker resources.
The imported DB/PAS inputs are configured separately as
`PARKBENCH_OPENEDGE_DB_BASE_IMAGE` and `PARKBENCH_OPENEDGE_PAS_BASE_IMAGE`.
