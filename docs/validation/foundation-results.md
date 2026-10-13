# Foundation validation evidence

Validated on 2026-09-15 in the local fake-service environment.

- `npm test`: 27 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm run build --workspace @parkbench/web`: passed.
- `npm run preflight -- --scenario examples/scenarios/crud-rest.json`: passed.
- `npm run smoke:fake`: passed.
- `git diff --check`: passed.

The integration coverage exercises all six terminal states, verifies raw
Prometheus export and artifact registration before cleanup, preserves export
diagnostics on failure, keeps host and container disk I/O separate, and records
required observer gaps as `INCOMPLETE`. A live OpenEdge smoke test remains gated
on operator-supplied licensed inputs.
