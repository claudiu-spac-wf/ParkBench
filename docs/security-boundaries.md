# Security boundaries

The MVP binds its UI and API to localhost. Docker cleanup uses exact ParkBench
ownership labels and the artifact server resolves paths below the managed root.
Secrets are references only. Request IDs, credentials, generated data, and
unbounded request details are excluded from metric labels and ordinary artifacts.

Image references are required to have an explicit tag other than `latest`;
references may include an operator supplied digest, but ParkBench does not record or compare resolved digests. Tag-only
references are a convenience for local development, not a byte-level
reproducibility guarantee. `.env.local` and private OpenEdge inputs remain
local, and malformed environment diagnostics report only safe file/setting
metadata rather than values.

Database Latency (feature 016) is the only run feature that grants a Linux
capability. For a run with a non-zero `network.databaseLatencyMs`, the generated
Compose project adds `latency-<target>` sidecars that run the pinned observer
image as root with `cap_add: [NET_ADMIN]` and `network_mode: service:<target>`.
The capability is limited to the network namespace of that run's own database
or PAS container; it is never granted to the OpenEdge containers (which keep
their non-root user), to the platform services, or to runs without latency. The
sidecars carry the run's ownership labels and are removed with the run on every
terminal state, which also removes the traffic-control state.
