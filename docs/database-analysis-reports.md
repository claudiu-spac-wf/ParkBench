# Database analysis reports

Open **Reports** in the main navigation. Select a ready catalog database seed and a report type, then choose **Generate report**. You do not need an experiment, workload, PAS or metrics stack. Refresh or return to the report URL to inspect the same request. A deliberate rerun gets its own identity and files.

Use **Report view** to choose **Full report overview**, **Review findings**, one dataset, or **Files and downloads**. The selected view is included in the URL and survives refresh. Finding/chart source links open the corresponding dataset with its object or area filter. Collection status and cancellation remain available in every view.

Overview content sizes use decimal units (1KB = 1,000 bytes, 1MB = 1,000,000 bytes) with up to two decimal places, for example `2MB` or `25.78GB`. Hover over a size for its exact byte count; exact source values also remain in the dataset and full CSV. Each distribution bar starts with its percentage of that chart's content total. A tiny nonzero share is shown as `<0.01%`.

Dataset tables use the free MIT-licensed **Material React Table**. Use the toolbar to show column filters, select visible columns, change density or expand the grid. Drag column handles to reorder; resize using header separators. Timestamp, DBUID, DB name, Partition Type, Tenancy, Tenancy #, Partition Policy, Partition, Partition #, Owner, Table #, Index # and Area # start hidden and can be restored from **Show/Hide columns**. Object/Concern stays pinned on the left and cannot be hidden, reordered or unpinned. While rows are still loading, sorting and filters query the full retained dataset on the server. Once the complete unfiltered dataset is loaded, the grid reuses it for local sorting/filtering without another download. Both paths share exact numeric/filter rules, including values beyond 2^53, literal text matching and missing-last sorting. Column filters support literal text matching or exact numeric comparisons, with up to 16 active filters and 256 characters per value. There are no page controls. Opening a dataset automatically loads all matching rows in bounded network batches, with the first batch visible immediately and loading progress shown. Scroll through the complete dataset; only visible rows are rendered to keep the grid responsive. Changing a filter or sort cancels an unfinished query; a complete loaded dataset is reused immediately. If loading fails partway through, the visible prefix is explicitly incomplete and **Retry rows** restarts loading. Full CSV remains available.

Grid headers show plain native metric names such as Levels, Size and Utilization. Percent values include %, for example 56.5%; byte values use compact decimal units such as 123b or 2.5KB. Hover over a size for its exact original byte value; numeric filters still use raw numbers (bytes for size filters and no % suffix for percentage filters). Full CSV headers retain their measurement units and source numeric precision.

Object/Concern and individual assessed metric cells show a badge only for **Review** or **Higher concern**. Neutral and size-exempt values show no status text. Missing/invalid measurements remain identified, and an unflagged value does not establish health. Hover over or keyboard-focus the column's **i** icon for methodology, thresholds, applicability and source. **Files and downloads** always provides the complete retained CSV, including hidden columns and rows excluded by current filters.

| Utility   | Collected datasets                              |
| --------- | ----------------------------------------------- |
| DBANALYS  | Chain, index, table, block, applicable LOB data |
| IDXANALYS | Index and block data                            |
| TABANALYS | Table, block, applicable LOB data               |

ParkBench mounts the offline seed read-only and uses the same DB entrypoint as experiments to copy it into report-owned temporary storage, repair extent paths on the copy and start a broker. DBANALYS, IDXANALYS and TABANALYS run without `-RO` inside that database container after broker readiness. The source seed is never used as the working database. A licensed explicit ParkBench OpenEdge 12.8 DB image with the experiment entrypoint, accessible Docker/Compose and enough writable artifact storage for the database copy and outputs are required. Native compatibility remains a separate acceptance gate.

Copying and extent preparation use the existing experiment startup scripts. They change only the temporary copy under `/psc/wrk/<database>`. The report container publishes no ports and uses no network. Cancellation and completion stop the owned container before the temporary copy is deleted. Uncertain termination or copy deletion retains the host claim and retries cleanup; raw output, CSV and diagnostics remain independent of the temporary database.

## Lifecycle and scheduling

Reports are independent of experiments and their retention. QUEUED reports run FIFO, always before waiting experiments. Active reports and entire active experiments finish uninterrupted. Submitting a report does not start a paused experiment queue.

RUNNING reports have **no automatic duration or inactivity timeout**. A quiet tool is still running; elapsed time is not a progress percentage. Use **Cancel report** to request termination. A queued report cancels immediately. A running report stays RUNNING until its actual owned resources have stopped and cleanup is confirmed.

If Docker cannot confirm cleanup, **Cleanup pending** displays the pending outcome and retry timestamp. Capacity stays reserved. One serialized worker retries five seconds after each failed attempt finishes without a retry-count cutoff. Repeated cancellation wakes that worker; it does not create another. Restoring Docker connectivity permits automatic recovery without restarting the controller. Observation failure alone does not stop a healthy utility.

On controller restart, a previous RUNNING report is interrupted. Its pending outcome becomes FAILED with `report_interrupted`; this classification survives a later cancellation. ParkBench cleans up owned resources before publishing the terminal failure. Queued requests stay queued. Native analysis is never automatically rerun.

## Retained evidence and downloads

Every report retains its seed identity, image/version, fixed options, collection timestamps, captured mount layout and immutable parser/column/CSV/rule versions. These describe historical collection time rather than the seed's present contents. Removing a seed or cleaning run artifacts does not delete report evidence.

Use **Download full dataset** for complete retained UTF-8 CSV. Search, filters, sorting and chart selection never change the downloaded file. Measurement headers include their units, for example `Size [bytes]`, `Utilization [%]` and `Frag Factor [ratio]`. Unknown semantics carry ` [unit unknown]`. Original native headers and the ordinal-to-CSV mapping remain in metadata and native source files. CSV uses comma separators, CRLF records, escaped double quotes and original numeric lexemes, including trailing zeros and integers above 2^53. Spreadsheet software may round large numbers; import such columns as text when precision matters.

**Incomplete evidence** means collection was cancelled, failed or malformed. A valid partial CSV contains only verified complete records and does not establish complete coverage. Native source files preserve malformed/truncated evidence separately. One missing file does not hide other downloads. An absent required LOB output is not assumed to mean no LOBs: without a verified native explanation it is missing output and collection fails. A header-only LOB file is explicitly empty.

AVAILABLE, EMPTY, NOT APPLICABLE, NOT COLLECTED, MISSING and UNSUPPORTED have different meanings. Blank/unknown/invalid values are unavailable, never measured zero. Unsupported visualization does not hide CSV. Downloads are registered by report/artifact identity, regular-file type and containment; requests cannot choose a filesystem path.

## Metrics and scope

The in-app guide and each table header show versioned contextual help. Source text remains authoritative. All counts, byte totals, comparisons, sorting and thresholds use exact nonnegative numbers.

| Native column(s)                                            | Meaning / CSV unit                                     |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Time Stamp                                                  | Native collection timestamp                            |
| DBUID / DB name                                             | Native database identity / name                        |
| Area / Area #                                               | Storage area name / identifier                         |
| Partition Type / Partition Policy / Partition / Partition # | Native partition context                               |
| Tenancy / Tenancy #                                         | Native tenancy context                                 |
| Owner / Table / Table #                                     | Schema owner and qualified table identity              |
| Index / Index #                                             | Index name / identifier                                |
| Field / LOB Obj #                                           | LOB field / storage object identity                    |
| Object type / Object / Object #                             | Chain object classification / identity                 |
| Chain Type / Block Type / State                             | Native chain category / block category / index state   |
| Num Blocks / Blocks                                         | Native category blocks / index blocks `[blocks]`       |
| Size                                                        | Reported object content `[bytes]`                      |
| Fields / Levels                                             | Index field count `[fields]` / tree depth `[levels]`   |
| Records / LOBs                                              | Table records `[records]` / large objects `[LOBs]`     |
| Min / Max / Mean                                            | Minimum / maximum / mean record or LOB size `[bytes]`  |
| Frag Count                                                  | Record fragments `[fragments]`                         |
| Frag Factor / Scatter Factor                                | Table fragmentation / scattering `[ratio]`             |
| Utilization                                                 | Index block utilization `[%]`                          |
| Factor                                                      | Native index factor `[ratio]`; not table fragmentation |

Charts show **full-report** collected object content, not physical database allocation. Index-only charts measure index content only. Block counts remain separate from bytes; chains do not add database bytes. Top 20 entries plus exact **Other** cover all measured contributions. Qualified area/owner/table/index/LOB/tenancy/partition contexts distinguish objects with the same display name. Missing values make affected totals incomplete. A zero denominator displays no measured content, not a health assessment.

## Concern indicators

Color supplements text. **Review** is amber; **Higher concern** is red. Neutral is not a positive health label. Missing/invalid values are unavailable; small/empty objects are not assessed. No findings does not establish health. Findings link to source rows and are separate from execution errors/warnings.

| Rule                | Applicability          | Review                   | Higher concern    | Basis                                                          |
| ------------------- | ---------------------- | ------------------------ | ----------------- | -------------------------------------------------------------- |
| Table fragmentation | Nonempty table         | 1.5 <= factor < 2        | factor >= 2       | Progress guidance                                              |
| Table scatter       | At least 1,000 records | 1.5 <= factor < 2        | factor >= 2       | ParkBench heuristic, including size exemption and red boundary |
| Index utilization   | At least 100 blocks    | 25% <= utilization < 50% | utilization < 25% | ParkBench heuristic, including block exemption                 |

These fixed rules prioritize review. They do not prove corruption or guarantee performance problems. Workload, expected growth and baseline measurements matter. Index Factor has no warning rule. There is no threshold editor or automatic maintenance action.

## Failure recovery

`report_seed_invalid` or `report_seed_unavailable`: select a ready structurally valid seed. `report_database_start_failed`: review seed copy, extent preparation, readiness and broker diagnostics. Historical `report_seed_not_offline` failures describe the earlier direct-seed adapter. `report_tool_unavailable` or `report_tool_version_unsupported`: check the configured image, tools and license. `report_output_invalid`, `report_dataset_missing`, or `report_storage_failed`: inspect retained native diagnostics and storage. `report_cleanup_failed`: restore Docker and watch the automatic retry. `report_interrupted`: inspect retained evidence and submit a deliberate new request if needed.

## Primary references

- [OpenEdge 12.8 CSV output schema](https://docs.progress.com/bundle/openedge-database-management-128/page/Output-file-format.html)
- [DBANALYS](https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-DBANALYS-qualifier.html)
- [IDXANALYS](https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-IDXANALYS-qualifier.html)
- [TABANALYS and fragmentation guidance](https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-TABANALYS-qualifier.html)
- [Read-only connections](https://docs.progress.com/bundle/openedge-database-management-128/page/Read-only-connections.html)


## Native number formatting and existing reports

OpenEdge can pad numeric CSV fields with spaces. ParkBench normalizes that padding only for numeric interpretation while retaining the original source and CSV text. LOB Min, Max and Mean accept their documented decimal byte values. On startup, affected historical report projections are rebuilt from their retained CSV, including numeric sort indexes and concern findings. The report identity, lifecycle and source files are retained. The report records a correction warning; a failed repair keeps the previously published generation and can retry after the required CSV is restored. No seed access or native report rerun is needed for this repair.
