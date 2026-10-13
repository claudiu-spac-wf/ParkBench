# OpenEdge workload authoring

Add procedures below `openedge/workloads/Workloads`. A selectable procedure
must accept exactly one parameter:

```abl
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
```

The request envelope is fixed to `procName` and `input`; all workload-specific
fields belong inside `input`. Procedure names are canonical POSIX paths such as
`Workloads/ParkBench/bank_mix.p` and may not contain traversal,
backslash, encoded separators, or another extension.

The final image build discovers the sources, validates the signature, compiles
each procedure with `PARKBENCH_OPENEDGE_COMPILER`, packages the runner archive,
and rebuilds PASOE. The supplied compiler command starts the generic DB image
with a fresh empty database loaded from the matching `.df` file
(`PARKBENCH_OPENEDGE_COMPILE_SCHEMA`),
and runs an ABL `COMPILE ... SAVE` driver through `pro`, so the source compiles
against the same schema the runs use. The generic image is an intermediate runner and is
not accepted by ParkBench. Procedures complete normally for a successful `200`
acknowledgement and raise an ABL error for a `500` workload failure.

A procedure file may contain `DEFINE INPUT PARAMETER` exactly once (its
`SingleParam`); use user-defined `FUNCTION`s for helpers. `/work` returns no
workload data, so a procedure that must check result sizes enforces its own
bounds and raises an error when one is violated; the load generator counts that
request as failed. A `RETURN ERROR "<code>"` whose text is a token of at most 200
characters from `[A-Za-z0-9_.:-]` is returned as the response's `detail` (for
example `{"ok":false,"error":"workload_failed","detail":"workload_bounds_violated:range:DebitTransaction:0"}`);
other error text is never sent.

### Workload contracts

A workload that needs schema readiness or seed checks ships a sibling
`<name>.contract.json` (`workload-contract.v1`, see
`openedge/workloads/Workloads/ParkBench/bank_mix.contract.json`). It declares the
logical database name, the required tables with minimum rows, fields, indexes
and sequences, each operation's row-count bounds, and the tables it writes.
Before any container starts, ParkBench checks that the contract's database name
matches the selected seed's `<db>.db` (`workload_database_mismatch`). The tables,
fields, indexes and rows are checked against the run's own copy: with
`"readiness": {"mode": "validate"}`,
the PAS observer posts `{"mode": "validate"}` to the procedure on every replica
before measurement; a `database_schema_invalid:` error fails the run.

### Generic workloads

A procedure that is not tied to fixed tables declares `"tableScope": "any"` in
its contract. Its `requiredTables` may be empty, every operation lists
`"tables": ["*"]`, `databaseName` may be `"*"` (any seed), it must not declare
written tables, and its readiness mode must be `"none"`. Contracts without
`tableScope` behave as before (`"declared"`).

`Workloads/Generic/arbitrary_reads.p` (contract `generic-arbitrary-reads`) reads
any application table through a `NO-LOCK` dynamic query:

| `input` key   | Type             | Meaning                                                                        |
| ------------- | ---------------- | ------------------------------------------------------------------------------ |
| `mode`        | string           | `run` reads data; `validate` checks the parameters and prepares the query only |
| `TableName`   | string, required | Application table to read                                                      |
| `WhereClause` | string or null   | Condition; a leading `WHERE` is optional; empty means all records              |
| `Limit`       | integer or null  | Most records per pass; null, absent or `<= 0` means no limit                   |
| `FieldsList`  | string array     | Becomes `FIELDS (...)`; `LobFields` are added to it                            |
| `LobFields`   | string array     | BLOB/CLOB fields copied into a `MEMPTR` for every record read                  |

Each request repeats read passes until at least 1000 ms have passed (at least one
pass always runs), so per-request HTTP overhead does not dominate. Unknown LOB
values are skipped and still counted. The procedure raises these error codes;
`/work` reports them as HTTP 500 `workload_failed` with the code in `detail`:

| Code                                       | Cause                                                        |
| ------------------------------------------ | ------------------------------------------------------------ |
| `invalid_work_mode`                        | `mode` missing or not `run`/`validate`                       |
| `invalid_work_input:<Key>`                 | A key has the wrong JSON type                                |
| `arbitrary_reads_invalid:table:<name>`     | Missing, unknown or non-application table                    |
| `arbitrary_reads_invalid:field:<name>`     | A `FieldsList`/`LobFields` entry is not a field of the table |
| `arbitrary_reads_invalid:lob_field:<name>` | A `LobFields` entry is not BLOB or CLOB                      |
| `arbitrary_reads_invalid:where_clause`     | The built query does not compile                             |
| `arbitrary_reads_failed:<msgnum>`          | Runtime error during a pass                                  |

Never reset the session timer (`ETIME(YES)` / `ETIME(TRUE)`) in a workload:
`ParkBenchWorkHandler.cls` resets it before running the procedure and reads it
afterwards for `elapsedMs` and the 60 s guard. Measure from a local baseline
(`start = ETIME`) instead.

The load generator replaces any `"generated"` value in a request body with a
deterministic `{name, value, sequence}` record from the run's effective load
seed, which a workload can use to choose rows reproducibly. `bank_mix.p` does
this for point, selective and range reads and a self-cleaning `AuditLog`
create/update/delete cycle.

Use the dedicated scenario as the request example:

```json
{
  "procName": "Workloads/ParkBench/bank_mix.p",
  "input": { "mode": "run", "op": "range", "key": "generated" }
}
```

The handler is served by PASOE's WEB transport, so the full initial URL is
`http://<pas-host>:8810/parkbench/web/work`; `/work` is the operation path in
the scenario. No dispatcher or complete business application change is
required when adding a procedure that follows this contract.

## Fixed table create/update workloads

`Workloads/Write/<Table>.p` supplies one independently selectable procedure for each of the 32 benchmark tables. Each takes exactly one `SingleParam AS LONGCHAR` containing JSON with Operation, Limit, WhereClause, FieldsList and LobFields. Its adjacent contract declares only that target as written and exposes read-only schema readiness. See [table write workloads](table-write-workloads.md) for complete inputs, examples, coverage and LOB byte sizes.

The generated wrappers share typed policy planning and explicit assignment includes. Creates assign every ordinary field and exactly the selected payloads. Updates freeze at most Limit distinct native matching identities in primary-ID order, then assign only selected ordinary/LOB fields. Helpers read actual parents and check complete unique tuples; they do not create parent records, maintain metadata, fabricate keys or modify unselected timestamps/companions. Any active-transaction error or STOP undoes the entire request. Sequence gaps remain valid.

The handler owns the write transaction and accepts its deadline verdict before commit. Keep workload transactions joined to that boundary, propagate errors/STOP, and release request resources after the outcome. Never reset ETIME, perform hidden retries, delete successful writes, or restore old values after success. Input `{"mode":"validate"}` checks schema only and allocates no sequence or payload.

For a local operator walkthrough, build the final image with `npm run openedge:build -- --image-stage final`, select `parkbench-banking-writes@1.0.0` from the configured scenario root, and use the documented `/parkbench/web/work` examples for ordinary create, selective ordinary update, combined content/companion update and LOB-only update. The licensed record launcher supports `--suite creates`, `--suite updates` and `--suite scenario`; these inspect actual run-owned data before cleanup. Source validation alone cannot establish persisted-record acceptance.
