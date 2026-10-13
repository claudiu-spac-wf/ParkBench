# Environment and image simplification validation

This record covers the ease-of-use changes that automatically load `.env.local`
and accept explicit image tags without requiring digests.

## Automated validation protocol

From the ParkBench repository root:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:contract
npm run test:integration
npm run test:security
npm run smoke:fake
./scripts/compose.sh config --quiet
git diff --check
```

The environment contract tests cover parsing, process-environment precedence,
missing-file behavior, redacted diagnostics, section layout, entry-point
inventory, and platform-image validation. The image-reference tests cover
tag-only references, tag-plus-digest references, registry ports, and rejection
of `latest`, untagged, and malformed references.

The fake smoke path is intentionally run with tag-only image references so the
test proves that a digest is not required. The Compose configuration check
proves that the sectioned environment values are sufficient for the platform
definition.

Automated execution on 2026-09-21 produced these results:

- `npm test`: 175 passed, 4 expected licensed/live OpenEdge tests skipped.
- `npm run test:contract`: 75 passed.
- `npm run test:integration`: 81 passed, 4 expected licensed/live OpenEdge tests skipped.
- `npm run test:security`: 15 passed.
- `npm run test:unit`: 7 passed.
- `npm run test:ui`: 8 passed.
- `npm run smoke:fake`: passed with tag-only fake image references.
- `docker compose ... config --quiet`, typecheck, lint, format check, and
  `git diff --check`: passed.
- `./scripts/preflight.sh --help`: passed without requiring a manually sourced
  environment file.

The convergence rerun also passed the expanded entry-point coverage in
`tests/integration/environment-loading.test.ts`: every npm script is routed
through the environment wrapper, every shell helper uses the shared loader,
and every direct entry point has a direct or transitive loader bootstrap.
The rerun reported 81 integration tests passed and 4 expected licensed/live
OpenEdge tests skipped.

The Playwright browser command was attempted with a 45-second timeout but did
not start a browser or web-server process and exited with status 124. No
Playwright/Vite process remained afterward. The repository’s browser workflow
contract suite is included in the full non-live test run and passed.

The licensed OpenEdge build/smoke portions of the operator quickstart remain
gated on private Progress inputs and were not rerun as part of this repository
change; the existing OpenEdge validation record documents that prerequisite.

## Manual operator study

A ten-operator first-run study has not been performed in this repository-only
validation environment. The intended study protocol is to give ten operators
the repository and ask each to complete first setup, fake smoke, and one
tag-only image configuration without additional explanation. Record whether the
operator succeeds, elapsed time, the first point of confusion, and any manual
environment-loading or digest workaround. Treat the study as passing only when
at least 9 of 10 operators complete the flow without an undocumented workaround
and the median completion time is within the agreed target.
