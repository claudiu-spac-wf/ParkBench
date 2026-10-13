# Workload procedures

Place benchmark procedures below `Workloads/`. Each selectable procedure must
use the exact signature:

```abl
DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.
```

Procedure names are canonical POSIX paths beginning with `Workloads/` and
ending in `.p`. Workload-specific fields belong inside the request `input`
value; the dispatcher contract does not change when a procedure is added.

`Workloads/Generic/arbitrary_reads.p` is a generic, read-only procedure whose
table, filter, record limit, returned fields and LOB fields all come from
`input`; see "Generic workloads" in `docs/workload-authoring.md`.
