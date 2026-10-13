# Scenario authoring

Author scenarios as `scenario.v2` JSON documents. They declare a REST target,
one to eight PAS replicas, weighted operations, phase durations, and required
or optional observers. Observer declarations do not select metric names: every
valid metric returned by an enabled observer is published. Use
`requiredMeasurements` to name measurements needed for a valid run. Existing
`scenario.v1` files remain readable for compatibility; their observer metric
lists do not filter output. See [the bundled examples](../examples/scenarios/)
for complete v2 documents. Change the declared scenario version when the
workload or observer contract changes.

## Per-request random values (`templateValues`)

An operation may declare named random whole numbers and use them as `{{name}}`
placeholders inside any string of its `bodyTemplate`:

```json
{
  "id": "debit-history-amounts",
  "method": "POST",
  "path": "/work",
  "weight": 5,
  "templateValues": { "band": { "kind": "uniformInt", "min": 1, "max": 1000 } },
  "bodyTemplate": {
    "procName": "Workloads/Generic/arbitrary_reads.p",
    "input": {
      "mode": "run",
      "TableName": "DebitTransaction",
      "WhereClause": "RandomInt1000 = {{band}}",
      "Limit": 2000,
      "FieldsList": ["AccountId", "Amount"]
    }
  },
  "expectedStatus": [200]
}
```

- Names match `^[A-Za-z][A-Za-z0-9]{0,31}$`, at most 8 per operation; the only
  kind is `uniformInt` with inclusive integer `min` <= `max`.
- For every request the load generator draws one value per name (ascending name
  order) from the worker's seeded generator and replaces every occurrence of
  `{{name}}` with its decimal text. The same run seed replays the same values.
  `"generated"` key records are substituted afterwards, unchanged.
- Only whole numbers are inserted, so a placeholder cannot add query text.
- Validation rejects `scenario_template_value_bounds:<op>:<name>` (bounds out of
  order), `scenario_template_value_undeclared:<op>:<name>` (placeholder without a
  declaration) and `scenario_template_value_unused:<op>:<name>` (declaration that
  is never used).

## Bundled read mix (`parkbench-read-mix`)

`examples/scenarios/parkbench-read-mix.json` contains 16 read operations using
`Workloads/Generic/arbitrary_reads.p`. Every operation uses
`RandomInt1000 <= 870 AND RandomInt1000 = {{band}}`, a uniform band from 1 to
870 and `Limit=0`. Each request reads complete buckets for at least one second.
The eligible footprint is 9,001,874,703 bytes on the calibrated reference seed;
repeated requests have no cumulative-byte quota. All original projected fields,
requested LOBs and conditional operation weights are preserved.

| Operation | Table | FieldsList | LobFields | Weight |
| --- | --- | --- | --- | --- |
| reference-currencies | Currency | — | — | 8 |
| reference-transaction-types | TransactionType | — | — | 6 |
| product-catalog | AccountType | — | — | 4 |
| customer-profiles | Customer | — | — | 10 |
| account-overview | Account | — | — | 12 |
| contact-lookup | CustomerContact | — | — | 6 |
| debit-history-amounts | DebitTransaction | AccountId, Amount | — | 5 |
| card-auth-amounts | CardAuthorization | CardId, Amount | — | 4 |
| credit-history | CreditTransaction | — | — | 4 |
| login-history | LoginEvent | — | — | 3 |
| audit-review | AuditLog | — | — | 2 |
| statement-download | StatementDocument | — | PdfContent, StatementXml | 2 |
| kyc-document-review | CustomerDocument | — | Content | 2 |
| customer-notes | CustomerNote | — | NoteText | 3 |
| staff-directory | Employee | — | Photo | 1 |
| statement-notices | AccountStatement | — | NoticeText | 2 |

The three mixed presets are `parkbench-read-write-90-10`,
`parkbench-read-write-80-20`, and `parkbench-read-write-70-30`. They each have
33 operations: the same 16 calibrated reads and the 17 unchanged banking writes.
Read/write weights use separate integer multipliers 450 and 37 for 90/10,
200 and 37 for 80/20, and 350 and 111 for 70/30. Total integer weights are
37000, 18500, and 37000. Original operation inputs and each group's conditional
probabilities remain unchanged. Ratios describe selection probabilities, including
failed attempts, rather than successful counts, time spent, bytes, or transactions.
Contention and finite-domain write failures remain visible.

Standalone reads and all three mixes use concurrency 10, one in-flight request
per worker, seed 2026, one PAS replica, a 60000ms deadline, common observers and
30/120/10-second phases. The standalone banking write preset remains available
with its own load settings. See [calibration](benchmark-read-calibration.md) for
provenance, seed refresh, verification and the combined 8 GiB cache baseline.

### Database memory limit

`PARKBENCH_DB_MEMORY_LIMIT=10g` in the operator environment sets a hard Docker
limit for each database container, including container-charged filesystem cache.
The combined memory and swap limit is the same value, so the database receives
no additional swap allowance. The default leaves 2 GiB above the planned 8 GiB
combined `-B`/`-B2` cache for database overhead. Adjust it for the host and cache
configuration; a database that exceeds it can be killed by Docker. The setting
also applies to native validation and compilation database containers.

Run native benchmark experiments sequentially. The cap is per container; it
does not bound the total memory used by Docker Desktop, PAS, or other services.
Existing containers retain their original limits until recreated.
