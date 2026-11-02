/** Audited measurement meanings. Presentation metadata never changes metric identities/formulas. */
export const COMPARISON_METRIC_HELP: Record<
  string,
  { displayName: string; description: string; scopeDescription: string }
> = {
  "resource.platform.cpu.usage": {
    displayName: "Platform services · CPU usage",
    description:
      "Consumed CPU time, displayed as percentage of one core; may exceed 100% with several cores. Source: container_cpu_usage_seconds_total.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.platform.memory.used": {
    displayName: "Platform services · Working-set memory",
    description:
      "Container working-set memory; not total host memory or database buffer capacity. Source: container_memory_working_set_bytes.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.platform.disk.read.bytes": {
    displayName: "Platform services · Disk bytes read",
    description:
      "Bytes read from storage; distinct from the number of I/O operations. Source: container_fs_reads_bytes_total.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.platform.disk.write.bytes": {
    displayName: "Platform services · Disk bytes written",
    description:
      "Bytes written to storage; distinct from the number of I/O operations. Source: container_fs_writes_bytes_total.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.platform.disk.read.operations": {
    displayName: "Platform services · Disk read operations",
    description:
      "Storage read request count; distinct from database-native block reads. Source: container_fs_reads_total.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.platform.disk.write.operations": {
    displayName: "Platform services · Disk write operations",
    description:
      "Storage write request count; distinct from database-native block writes. Source: container_fs_writes_total.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.platform.network.receive": {
    displayName: "Platform services · Network bytes received",
    description:
      "Received network bytes; separate from transmitted traffic. Source: container_network_receive_bytes_total.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.platform.network.transmit": {
    displayName: "Platform services · Network bytes transmitted",
    description:
      "Transmitted network bytes; separate from received traffic. Source: container_network_transmit_bytes_total.",
    scopeDescription: "ParkBench platform-project service containers, not the whole host."
  },
  "resource.database.cpu.usage": {
    displayName: "Database container · CPU usage",
    description:
      "Consumed CPU time, displayed as percentage of one core; may exceed 100% with several cores. Source: container_cpu_usage_seconds_total.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.database.memory.used": {
    displayName: "Database container · Working-set memory",
    description:
      "Container working-set memory; not total host memory or database buffer capacity. Source: container_memory_working_set_bytes.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.database.disk.read.bytes": {
    displayName: "Database container · Disk bytes read",
    description:
      "Bytes read from storage; distinct from the number of I/O operations. Source: container_fs_reads_bytes_total.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.database.disk.write.bytes": {
    displayName: "Database container · Disk bytes written",
    description:
      "Bytes written to storage; distinct from the number of I/O operations. Source: container_fs_writes_bytes_total.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.database.disk.read.operations": {
    displayName: "Database container · Disk read operations",
    description:
      "Storage read request count; distinct from database-native block reads. Source: container_fs_reads_total.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.database.disk.write.operations": {
    displayName: "Database container · Disk write operations",
    description:
      "Storage write request count; distinct from database-native block writes. Source: container_fs_writes_total.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.database.network.receive": {
    displayName: "Database container · Network bytes received",
    description:
      "Received network bytes; separate from transmitted traffic. Source: container_network_receive_bytes_total.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.database.network.transmit": {
    displayName: "Database container · Network bytes transmitted",
    description:
      "Transmitted network bytes; separate from received traffic. Source: container_network_transmit_bytes_total.",
    scopeDescription: "Owned database container for this run."
  },
  "resource.pas.cpu.usage": {
    displayName: "PAS containers · CPU usage",
    description:
      "Consumed CPU time, displayed as percentage of one core; may exceed 100% with several cores. Source: container_cpu_usage_seconds_total.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.pas.memory.used": {
    displayName: "PAS containers · Working-set memory",
    description:
      "Container working-set memory; not total host memory or database buffer capacity. Source: container_memory_working_set_bytes.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.pas.disk.read.bytes": {
    displayName: "PAS containers · Disk bytes read",
    description:
      "Bytes read from storage; distinct from the number of I/O operations. Source: container_fs_reads_bytes_total.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.pas.disk.write.bytes": {
    displayName: "PAS containers · Disk bytes written",
    description:
      "Bytes written to storage; distinct from the number of I/O operations. Source: container_fs_writes_bytes_total.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.pas.disk.read.operations": {
    displayName: "PAS containers · Disk read operations",
    description:
      "Storage read request count; distinct from database-native block reads. Source: container_fs_reads_total.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.pas.disk.write.operations": {
    displayName: "PAS containers · Disk write operations",
    description:
      "Storage write request count; distinct from database-native block writes. Source: container_fs_writes_total.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.pas.network.receive": {
    displayName: "PAS containers · Network bytes received",
    description:
      "Received network bytes; separate from transmitted traffic. Source: container_network_receive_bytes_total.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.pas.network.transmit": {
    displayName: "PAS containers · Network bytes transmitted",
    description:
      "Transmitted network bytes; separate from received traffic. Source: container_network_transmit_bytes_total.",
    scopeDescription:
      "All owned PAS containers plus separate recorded replica/service rows; not the platform or database container."
  },
  "resource.database.disk.space.file_size": {
    displayName: "Database · Database file length",
    description:
      "Logical filesystem file length; may include sparse regions. Source: parkbench_file_size_bytes.",
    scopeDescription: "One result per retained database-file identity; optional file/scope filters."
  },
  "resource.database.disk.space.allocated": {
    displayName: "Database · Database file allocated space",
    description:
      "Filesystem allocated bytes; distinct from logical file length. Source: parkbench_file_disk_usage_bytes.",
    scopeDescription: "One result per retained database-file identity; optional file/scope filters."
  },
  "resource.database.disk.space.bi_logical": {
    displayName: "Database · BI logical space",
    description:
      "Native BI logical size; distinct from individual file length/allocated filesystem bytes. Source: parkbench_openedge_db_bi_file_size_bytes.",
    scopeDescription: "Native BI logical-size evidence, grouped by retained file/scope identity."
  },
  "database.db.records.read": {
    displayName: "Database · Record reads (whole database)",
    description: "Record reads. Source: parkbench_openedge_db_database_table_operations_total.",
    scopeDescription:
      "Native _ActSummary database-wide counters, independent of inventoried table coverage."
  },
  "database.db.table.read": {
    displayName: "Database · Record reads (per table)",
    description: "Record reads. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "One retained row per observed table; table filter selects a row and does not aggregate tables."
  },
  "database.db.tables.aggregate.read": {
    displayName: "Database · Record reads (observed-table aggregate)",
    description: "Record reads. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "Additive aggregate across inventoried/covered table constituents; not the whole database and not per-table rows."
  },
  "database.db.records.create": {
    displayName: "Database · Record creates (whole database)",
    description: "Record creates. Source: parkbench_openedge_db_database_table_operations_total.",
    scopeDescription:
      "Native _ActSummary database-wide counters, independent of inventoried table coverage."
  },
  "database.db.table.create": {
    displayName: "Database · Record creates (per table)",
    description: "Record creates. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "One retained row per observed table; table filter selects a row and does not aggregate tables."
  },
  "database.db.tables.aggregate.create": {
    displayName: "Database · Record creates (observed-table aggregate)",
    description: "Record creates. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "Additive aggregate across inventoried/covered table constituents; not the whole database and not per-table rows."
  },
  "database.db.records.update": {
    displayName: "Database · Record updates (whole database)",
    description: "Record updates. Source: parkbench_openedge_db_database_table_operations_total.",
    scopeDescription:
      "Native _ActSummary database-wide counters, independent of inventoried table coverage."
  },
  "database.db.table.update": {
    displayName: "Database · Record updates (per table)",
    description: "Record updates. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "One retained row per observed table; table filter selects a row and does not aggregate tables."
  },
  "database.db.tables.aggregate.update": {
    displayName: "Database · Record updates (observed-table aggregate)",
    description: "Record updates. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "Additive aggregate across inventoried/covered table constituents; not the whole database and not per-table rows."
  },
  "database.db.records.delete": {
    displayName: "Database · Record deletes (whole database)",
    description: "Record deletes. Source: parkbench_openedge_db_database_table_operations_total.",
    scopeDescription:
      "Native _ActSummary database-wide counters, independent of inventoried table coverage."
  },
  "database.db.table.delete": {
    displayName: "Database · Record deletes (per table)",
    description: "Record deletes. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "One retained row per observed table; table filter selects a row and does not aggregate tables."
  },
  "database.db.tables.aggregate.delete": {
    displayName: "Database · Record deletes (observed-table aggregate)",
    description: "Record deletes. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "Additive aggregate across inventoried/covered table constituents; not the whole database and not per-table rows."
  },
  "database.db.records.write": {
    displayName: "Database · Record writes (create + update + delete) (whole database)",
    description:
      "Record modifications: create + update + delete, excluding reads. Source: parkbench_openedge_db_database_table_operations_total.",
    scopeDescription:
      "Native _ActSummary database-wide counters, independent of inventoried table coverage."
  },
  "database.db.table.write": {
    displayName: "Database · Record writes (create + update + delete) (per table)",
    description:
      "Record modifications: create + update + delete, excluding reads. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "One retained row per observed table; table filter selects a row and does not aggregate tables."
  },
  "database.db.tables.aggregate.write": {
    displayName: "Database · Record writes (create + update + delete) (observed-table aggregate)",
    description:
      "Record modifications: create + update + delete, excluding reads. Source: parkbench_openedge_db_table_operations_total.",
    scopeDescription:
      "Additive aggregate across inventoried/covered table constituents; not the whole database and not per-table rows."
  },
  "database.db.transactions.commit": {
    displayName: "Database · Committed transactions",
    description:
      "Native database-wide committed transaction count. Source: parkbench_openedge_db_transaction_commits_total.",
    scopeDescription: "Whole database; _ActSummary._Summary-Commits."
  },
  "database.db.transactions.rollback": {
    displayName: "Database · Rolled-back transactions",
    description:
      "Native database-wide rollback count. Source: parkbench_openedge_db_transaction_rollbacks_total.",
    scopeDescription: "Whole database; _ActSummary._Summary-Undos."
  },
  "database.db.blocks.read": {
    displayName: "Database · Database blocks read",
    description:
      "Native database block reads. Source: parkbench_openedge_db_database_blocks_read_total.",
    scopeDescription:
      "Whole-database _ActSummary._Summary-DbReads; distinct from per-pool _ActBuffer OS read counters and container I/O requests/bytes."
  },
  "database.db.buffer.logical.read": {
    displayName: "Database · Logical block read requests (by pool)",
    description:
      "Client logical database block read requests. Source: parkbench_openedge_db_buffer_pool_logical_reads_total.",
    scopeDescription:
      "Separate primary/alternate pool rows from _ActBuffer._Buffer-LogicRds; a pool filter retains the selected pool."
  },
  "database.db.buffer.physical.read": {
    displayName: "Database · Blocks read from disk (by pool)",
    description:
      "Physical database blocks read into the pool. Source: parkbench_openedge_db_buffer_pool_os_reads_total.",
    scopeDescription:
      "Separate primary/alternate pool rows from _ActBuffer._Buffer-OSRds; not logical read requests or a whole-database total."
  },
  "database.db.blocks.write": {
    displayName: "Database · Database blocks written",
    description:
      "Native database block writes. Source: parkbench_openedge_db_database_blocks_written_total.",
    scopeDescription:
      "Whole-database _ActSummary._Summary-DbWrites; distinct from per-pool _ActBuffer OS write counters and container I/O requests/bytes."
  },
  "database.db.buffer.logical.write": {
    displayName: "Database · Logical block write requests (by pool)",
    description:
      "Client logical database block write requests. Source: parkbench_openedge_db_buffer_pool_logical_writes_total.",
    scopeDescription:
      "Separate primary/alternate pool rows from _ActBuffer._Buffer-LogicWrts; not disk writes."
  },
  "database.db.buffer.physical.write": {
    displayName: "Database · Blocks written to disk (by pool)",
    description:
      "Physical database blocks written by pool. Source: parkbench_openedge_db_buffer_pool_os_writes_total.",
    scopeDescription:
      "Separate primary/alternate pool rows from _ActBuffer._Buffer-OSWrts; not logical writes or a whole-database total."
  },
  "database.db.bi.write.blocks": {
    displayName: "Database · BI blocks written",
    description:
      "Before-image write volume in BI blocks. Source: parkbench_openedge_db_bi_blocks_written_total.",
    scopeDescription: "Native _ActBILog._BiLog-TotalWrts; not a filesystem I/O operation count."
  },
  "database.db.bi.write.bytes": {
    displayName: "Database · BI bytes written",
    description:
      "Before-image write volume in bytes. Source: parkbench_openedge_db_bi_bytes_written_total.",
    scopeDescription:
      "Native _ActBILog._BiLog-BytesWrtn; byte and block quantities remain distinct."
  },
  "database.db.bi.io": {
    displayName: "Database · BI I/O operations (by direction)",
    description:
      "Before-image read/write I/O operation count. Source: parkbench_openedge_db_bi_io_operations_total.",
    scopeDescription:
      "Separate operation=read/write rows from _ActIOType; distinct from BI block/byte volume."
  },
  "workload.completed": {
    displayName: "Workload · Completed requests",
    description:
      "Saved workload completed-request count. Source: saved workload requests.completed.",
    scopeDescription: "Measurement window only; total request count, not the per-second rate."
  },
  "workload.errors": {
    displayName: "Workload · Request errors",
    description: "Saved workload error-request count. Source: saved workload requests.errors.",
    scopeDescription: "Measurement window; not timeoutCount and not database rollback count."
  },
  "workload.timeouts": {
    displayName: "Workload · Request timeouts",
    description: "Saved workload timeout count. Source: saved workload timeoutCount.",
    scopeDescription: "Measurement window; distinct saved field from errors."
  },
  "workload.completed.rate": {
    displayName: "Workload · Completed requests per second",
    description:
      "Completed requests divided by recorded measurement duration. Source: saved workload requests.completed / measurement duration.",
    scopeDescription:
      "One measurement-window average; not percentile of sampled throughput or raw total."
  },
  "workload.latency.p50": {
    displayName: "Workload · Request latency p50",
    description: "Median observed request latency. Source: saved workload latencySeconds.p50.",
    scopeDescription:
      "Stored measurement-window latency quantile, shown through Value; not p50 of sampled averages."
  },
  "workload.latency.p95": {
    displayName: "Workload · Request latency p95",
    description:
      "95th-percentile observed request latency. Source: saved workload latencySeconds.p95.",
    scopeDescription:
      "Stored measurement-window latency quantile, shown through Value; not a rate percentile."
  },
  "workload.latency.p99": {
    displayName: "Workload · Request latency p99",
    description:
      "99th-percentile observed request latency. Source: saved workload latencySeconds.p99.",
    scopeDescription:
      "Stored measurement-window latency quantile, shown through Value; distinct quantile from p50/p95."
  },
  "native_latch.waits": {
    displayName: "Named latches · Wait naps",
    description: "Owned named-latch wait/nap count. Source: latch_named_waits_total.",
    scopeDescription:
      "Measurement-only, grouped by stable latch name/type across applicable instances/epochs; requires retained inventories."
  },
  "native_latch.duration": {
    displayName: "Named latches · Wait or spin time",
    description:
      "Owned named-latch wait/spin elapsed duration. Source: latch_named_wait_or_spin_duration_seconds_total.",
    scopeDescription:
      "Measurement-only, grouped by name/type; seconds rather than wait/nap count; requires retained inventories."
  }
};
