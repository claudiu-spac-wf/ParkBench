# Control UI validation record

Reference environment: Linux host, Node.js 24+, SQLite, fake orchestrator,
in-memory Prometheus test client, and the repository's pinned npm dependency
versions. No licensed OpenEdge inputs are required for the fake validation;
the licensed smoke suite remains separately gated.

Validated locally:

- TypeScript typecheck and production web build.
- Contract, unit, integration, and security suites.
- 16-cell Cartesian preview for `-B={500,1000,1500,2000}` ×
  `-B2={500,1000,1500,2000}`.
- Explicit confirmation, queue projection,
  descriptive comparison without a submission baseline, and dashboard fallback.
- Immutable image-operation output and redacted input boundaries.
- Automated acceptance instrumentation covers ten preview attempts and 1,000
  active-update latency samples; the Node fake-service threshold run emits its
  p95 results as `acceptance-thresholds` output.

Executable Playwright workflows cover catalog verification, scenario version
editing, 16-cell matrix confirmation, queue monitoring, selectable-baseline
comparison, dashboard health, and evidence history. The fixture-backed suite
routes browser requests through `createControlUiFixture`; the acceptance suite
records ten fresh attempts for each SC-001 catalog, SC-002 matrix, and SC-006
comparison timing protocol, 1,000 browser update samples for SC-005, and ten
isolated operator-style journeys. Each protocol reports and asserts its own
threshold rather than sharing one timing limit.

SC-008 human acceptance evidence is intentionally not fabricated by automation.
The required ten first-time-operator session record is:

```text
Operator | Completed | External instructions used | Duration | Notes
---------|-----------|----------------------------|----------|------
H01      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H02      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H03      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H04      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H05      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H06      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H07      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H08      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H09      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
H10      | NOT RUN   | N/A                        | N/A      | Schedule a supervised session
```

The ten automated journeys are an operator-style proxy and do not satisfy the
human SC-008 result until those sessions are conducted. They require a
Playwright-supported browser in the CI or operator environment; the current
Ubuntu 26.04 reference image does not provide a supported Chromium binary, so
browser execution remains an environment-gated validation step. The full
licensed OpenEdge smoke test is skipped unless its documented prerequisites
are present.
