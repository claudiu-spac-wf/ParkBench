# Table write workloads

Each benchmark table has its own `Workloads/Write/<Table>.p` procedure and readiness contract. Invoke it through the existing PAS `/parkbench/web/work` endpoint with one JSON `input` object. Writes persist in the run-owned database until normal cleanup. The source seed is immutable; independent runs start from fresh copies.

## Create input

| Key                      | Rule                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| Operation                | Required, exactly `create`                                          |
| Limit                    | Required integer from 0 through 10,000; no coercion or default      |
| LobFields                | Optional array of target LOB names; omission or `[]` writes no LOBs |
| FieldsList / WhereClause | Completely ignored on creates, including invalid values             |

Create assigns every ordinary field, including primary identity, random selectors, optional dates, timestamps, business attributes and LOB companions. Values are generated internally. Parents come from actual existing rows; creates never add parent/companion records in other tables. Primary identities use the existing sequences. Business keys and complete unique tuples are checked against live data, and bounded encodings never wrap.

A successful request adds exactly Limit records. Limit zero validates input and succeeds without allocating sequence values or payloads. A finite catalog can run out of unused codes; a required parent may be absent; a unique statement or debit reference may already be used. These produce atomic failures rather than fewer records or fabricated values. A fully populated reference seed can legitimately reject new Currency/Country/type codes.

Field names are unqualified, case-insensitive schema names and are deduplicated. Property names and Operation values use the exact spelling shown. Invalid relevant lists (including null), foreign/unknown fields, ordinary fields in LobFields, malformed JSON and invalid limits fail before writes. `mode:run` is optional; the reserved `{mode:validate}` probe checks only schema shape and never advances sequences.

## Examples

Create ordinary records without LOB writes:

```json
{
  "procName": "Workloads/Write/CustomerDocument.p",
  "input": { "Operation": "create", "Limit": 10, "LobFields": [] }
}
```

Create records with binary content:

```json
{
  "procName": "Workloads/Write/CustomerDocument.p",
  "input": { "Operation": "create", "Limit": 1, "LobFields": ["Content"] }
}
```

Create a text note:

```json
{
  "procName": "Workloads/Write/CustomerNote.p",
  "input": { "Operation": "create", "Limit": 1, "LobFields": ["NoteText"] }
}
```

Create a statement document with both mandatory payloads:

```json
{
  "procName": "Workloads/Write/StatementDocument.p",
  "input": { "Operation": "create", "Limit": 1, "LobFields": ["PdfContent", "StatementXml"] }
}
```

The statement must already exist and have no document. Storage constraints can reject omission of mandatory LOBs; the workload does not silently populate an omitted field.

Send an example through the existing transport, replacing the URL with the disposable PAS target:

```bash
curl --fail-with-body -H 'Content-Type: application/json'   --data '{"procName":"Workloads/Write/Account.p","input":{"Operation":"create","Limit":1,"LobFields":[]}}'   http://127.0.0.1:8810/parkbench/web/work
```

The existing success acknowledgement contains `ok`, `procName`, `elapsedMs`, and `requestId`; it does not contain affected rows. Input/generation/assignment failures use `500/workload_failed`, incompatible readiness uses `500/database_schema_invalid`, and the 60-second deadline uses `408/workload_timeout`. Failed requests roll back record and LOB changes, but can leave sequence gaps.

## LOB payloads

Only explicitly selected fields get generated content. Payloads are staged for the current row, within documented byte bounds. Binary content is synthetic benchmark data; it is not promised to be a renderable JPEG or PDF. Text content uses UTF-8 bytes and StatementXml is well formed.

| Table.field                    | Type | Default bytes | Allowed documented range |
| ------------------------------ | ---- | ------------: | -----------------------: |
| Employee.Photo                 | BLOB |        24,576 |             8,192–49,152 |
| CustomerDocument.Content       | BLOB |        16,384 |             4,096–65,536 |
| CustomerNote.NoteText          | CLOB |         1,200 |                200–8,192 |
| StatementDocument.PdfContent   | BLOB |         8,192 |             3,072–32,768 |
| StatementDocument.StatementXml | CLOB |         3,072 |              1,024–8,192 |
| AccountStatement.NoticeText    | CLOB |         1,536 |                512–4,096 |

No payload-size input is exposed. Ordinary FileSizeBytes/Checksum values describe selected content, or zero bytes/the empty-content digest when the payload is omitted on create.

## Selective updates

An update requires `Operation: "update"`, an integer Limit, and a nonblank native target-table `WhereClause`. `FieldsList` selects ordinary fields; `LobFields` selects payloads. Missing or empty arrays select nothing in that category. A positive limit must select at least one field. Names are case-insensitive and deduplicated; qualified, unknown, foreign, wrong-category names and the primary identifier are rejected.

The native query evaluates the condition and chooses at most Limit distinct rows in ascending primary-ID order. For an unchanged, uncontended set, the count is exactly `min(Limit, matches)`. The engine freezes identities before assignments, so changing a predicate field cannot visit a row twice. Native functions and compound conditions are supported; the caller supplies an expression, not a query tail, table, ordering or lock clause. Volatile native functions use the query's evaluation; no second membership test is added.

Ordinary update with a native function and combined condition:

```json
{
  "procName": "Workloads/Write/Account.p",
  "input": {
    "Operation": "update",
    "Limit": 10,
    "WhereClause": "Account.RandomInt100 = 1 AND LENGTH(Account.Nickname) >= 3",
    "FieldsList": ["Nickname", "UpdatedAt"],
    "LobFields": []
  }
}
```

LOB-only update, preserving the other payload and every ordinary field:

```json
{
  "procName": "Workloads/Write/StatementDocument.p",
  "input": {
    "Operation": "update",
    "Limit": 1,
    "WhereClause": "StatementDocument.RandomInt100 = 1",
    "FieldsList": [],
    "LobFields": ["StatementXml"]
  }
}
```

Combined ordinary/binary update with selected companion metadata:

```json
{
  "procName": "Workloads/Write/CustomerDocument.p",
  "input": {
    "Operation": "update",
    "Limit": 1,
    "WhereClause": "CustomerDocument.RandomInt100 = 1",
    "FieldsList": ["FileSizeBytes", "UpdatedAt"],
    "LobFields": ["Content"]
  }
}
```

Every unselected field stays unchanged, including UpdatedAt and companion FileSizeBytes/Checksum. Selecting only a companion derives its value from existing content; selecting only a LOB preserves the companion even if the synthetic metadata then differs. A generated selected value can equal its previous value. Constrained reference codes may be reassigned their current value to preserve inbound relationships; selected unique tuple components are planned with unselected components retained.

Selection and reacquisition use native exclusive locks with NO-WAIT within the request transaction. A locked, missing or replaced frozen row fails the entire request; it is never silently skipped or replenished. This follows native concurrency semantics and does not promise snapshot isolation. Limit zero still validates fields and prepares the native condition, but allocates no sequence or payload. Zero matches succeed without assignments or allocations.

## Coverage

BenchmarkTableInfo is an explicit disposable metadata benchmark. Other workloads never maintain it automatically.

| Table               | Individually selectable procedure       |
| ------------------- | --------------------------------------- |
| Currency            | `Workloads/Write/Currency.p`            |
| Country             | `Workloads/Write/Country.p`             |
| ExchangeRate        | `Workloads/Write/ExchangeRate.p`        |
| Branch              | `Workloads/Write/Branch.p`              |
| Employee            | `Workloads/Write/Employee.p`            |
| AccountType         | `Workloads/Write/AccountType.p`         |
| InterestRateHistory | `Workloads/Write/InterestRateHistory.p` |
| TransactionType     | `Workloads/Write/TransactionType.p`     |
| MerchantCategory    | `Workloads/Write/MerchantCategory.p`    |
| Merchant            | `Workloads/Write/Merchant.p`            |
| Customer            | `Workloads/Write/Customer.p`            |
| CustomerAddress     | `Workloads/Write/CustomerAddress.p`     |
| CustomerContact     | `Workloads/Write/CustomerContact.p`     |
| CustomerDocument    | `Workloads/Write/CustomerDocument.p`    |
| CustomerNote        | `Workloads/Write/CustomerNote.p`        |
| Account             | `Workloads/Write/Account.p`             |
| AccountHolder       | `Workloads/Write/AccountHolder.p`       |
| Payee               | `Workloads/Write/Payee.p`               |
| ScheduledPayment    | `Workloads/Write/ScheduledPayment.p`    |
| Card                | `Workloads/Write/Card.p`                |
| Loan                | `Workloads/Write/Loan.p`                |
| StatementDocument   | `Workloads/Write/StatementDocument.p`   |
| AccountStatement    | `Workloads/Write/AccountStatement.p`    |
| MonthlyBalance      | `Workloads/Write/MonthlyBalance.p`      |
| CreditTransaction   | `Workloads/Write/CreditTransaction.p`   |
| Transfer            | `Workloads/Write/Transfer.p`            |
| LoanPayment         | `Workloads/Write/LoanPayment.p`         |
| LoginEvent          | `Workloads/Write/LoginEvent.p`          |
| DebitTransaction    | `Workloads/Write/DebitTransaction.p`    |
| CardAuthorization   | `Workloads/Write/CardAuthorization.p`   |
| AuditLog            | `Workloads/Write/AuditLog.p`            |
| BenchmarkTableInfo  | `Workloads/Write/BenchmarkTableInfo.p`  |

## Verification

Run from the ParkBench root:

```bash
node scripts/openedge/generate-write-workloads.mjs --check
node scripts/openedge/validate-write-workloads.mjs
node scripts/openedge/test-write-workloads.mjs --config .env.local --suite creates --tables all --report .parkbench/validation/table-write-creates.json
node scripts/openedge/test-write-workloads.mjs --config .env.local --suite updates --tables all --report .parkbench/validation/table-write-updates.json
```

The first two commands check sources/contracts; licensed native acceptance checks actual records, ordinary assignments, LOB hashes/omission, target-only writes, capacity failures and concurrent keys. Missing configuration, images, suite drivers or required cases fails the launcher. `--suite fixtures` validates independent test infrastructure only and cannot establish operational acceptance. Test fixtures live outside selectable Workloads and are never production inputs.

Measured-run resource summaries record the Prometheus scrape cadence and cAdvisor source timestamp age separately. At a measurement edge, the estimate may cover one scrape interval plus the recorded cAdvisor housekeeping interval, using the nearest segment wholly inside that phase. Estimated seconds stay visible in coverage; internal gaps, missing members and out-of-phase observations still fail the required evidence checks. Native database and workload observation rules are unchanged.

Required cAdvisor disk I/O checks use that same coverage calculation and retain the actual raw acquisition counts. A phase with 59 acquisitions can be complete when its observed segments and explicitly bounded edge estimates cover the whole window. A missing series, counter reset, or internal gap still makes it incomplete. Coverage storage uses the existing 100,000-sample bound per selector, and verification queries remain serial and chunked.
