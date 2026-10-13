import {
  MetricDefinition,
  ResourceGroup,
  METRIC_DEFINITIONS_VERSION,
  RESOURCE_METRICS_VERSION
} from "./metric-definitions";
const resources = [
  [
    "cpu.usage",
    "CPU usage",
    "container_cpu_usage_seconds_total",
    "counter",
    "cpu_seconds",
    "percent_one_core",
    "cpu_seconds",
    100,
    0.01
  ],
  [
    "memory.used",
    "Used memory",
    "container_memory_working_set_bytes",
    "gauge",
    "bytes",
    "bytes",
    null,
    1,
    1
  ],
  [
    "disk.read.bytes",
    "Disk reads",
    "container_fs_reads_bytes_total",
    "counter",
    "bytes",
    "bytes_per_second",
    "bytes",
    1,
    1
  ],
  [
    "disk.write.bytes",
    "Disk writes",
    "container_fs_writes_bytes_total",
    "counter",
    "bytes",
    "bytes_per_second",
    "bytes",
    1,
    1
  ],
  [
    "disk.read.operations",
    "Disk read operations",
    "container_fs_reads_total",
    "counter",
    "operations",
    "operations_per_second",
    "operations",
    1,
    1
  ],
  [
    "disk.write.operations",
    "Disk write operations",
    "container_fs_writes_total",
    "counter",
    "operations",
    "operations_per_second",
    "operations",
    1,
    1
  ],
  [
    "network.receive",
    "Network receive",
    "container_network_receive_bytes_total",
    "counter",
    "bytes",
    "bytes_per_second",
    "bytes",
    1,
    1
  ],
  [
    "network.transmit",
    "Network transmit",
    "container_network_transmit_bytes_total",
    "counter",
    "bytes",
    "bytes_per_second",
    "bytes",
    1,
    1
  ]
] as const;
export const RESOURCE_SUMMARY_CATALOG: MetricDefinition[] = ["platform", "database", "pas"].flatMap(
  (group) =>
    resources.map((r, i) => ({
      definitionId: r[0],
      displayName: r[1],
      group: group as ResourceGroup,
      sourceMetricNames: [r[2]],
      type: r[3],
      sourceUnit: r[4],
      rateOrLevelUnit: r[5],
      totalUnit: r[6],
      coverageScope: "resource",
      allowedDimensions: ["service", "replica", "direction"],
      required: i < 2,
      supportedStatistics:
        r[3] === "counter"
          ? (["average", "p90", "p95", "total"] as any)
          : (["average", "p90", "p95"] as any),
      authoritativePublisher: group === "platform" ? "cadvisor" : "parkbench-run-owned-cadvisor",
      sourceContractVersion: RESOURCE_METRICS_VERSION,
      scale: r[7],
      totalScale: r[8],
      catalogOrder: i
    }))
);
export const FILE_SUMMARY_CATALOG: MetricDefinition[] = [
  ["disk.space.file_size", "File size", "parkbench_file_size_bytes", "file"],
  ["disk.space.allocated", "Allocated file space", "parkbench_file_disk_usage_bytes", "file"],
  [
    "disk.space.bi_logical",
    "BI logical space",
    "parkbench_openedge_db_bi_file_size_bytes",
    "logical_bi"
  ]
].map((r, i) => ({
  definitionId: r[0],
  displayName: r[1],
  group: "database",
  sourceMetricNames: [r[2]],
  type: "gauge",
  sourceUnit: "bytes",
  rateOrLevelUnit: "bytes",
  totalUnit: null,
  coverageScope: r[3],
  allowedDimensions: ["file", "scope"],
  required: false,
  supportedStatistics: ["average", "p90", "p95"],
  authoritativePublisher: r[2].includes("openedge") ? "native_db_endpoint" : "file_sampler",
  sourceContractVersion: METRIC_DEFINITIONS_VERSION,
  catalogOrder: 20 + i
}));

export interface DatabaseMetricDefinition extends MetricDefinition {
  selectorDimensions: Record<string, string>;
}
const databaseDefinitions: Array<[string, string, string, string, string, Record<string, string>]> =
  [];
for (const operation of ["read", "create", "update", "delete", "write"]) {
  databaseDefinitions.push([
    `db.records.${operation}`,
    "database_table_operations_total",
    "records_per_second",
    "records",
    "database_native",
    operation === "write" ? {} : { operation }
  ]);
  databaseDefinitions.push([
    `db.table.${operation}`,
    "table_operations_total",
    "records_per_second",
    "records",
    "table_covered",
    operation === "write" ? {} : { operation }
  ]);
  databaseDefinitions.push([
    `db.tables.aggregate.${operation}`,
    "table_operations_total",
    "records_per_second",
    "records",
    "table_covered",
    operation === "write" ? {} : { operation }
  ]);
}
for (const [id, suffix] of [
  ["commit", "transaction_commits_total"],
  ["rollback", "transaction_rollbacks_total"]
])
  databaseDefinitions.push([
    `db.transactions.${id}`,
    suffix,
    "transactions_per_second",
    "transactions",
    "database_native",
    {}
  ]);
for (const direction of ["read", "write"]) {
  const suffix = direction === "read" ? "reads" : "writes";
  databaseDefinitions.push([
    `db.blocks.${direction}`,
    `database_blocks_${direction === "read" ? "read" : "written"}_total`,
    "blocks_per_second",
    "blocks",
    "database_native",
    {}
  ]);
  for (const pool of ["primary", "alternate"]) {
    databaseDefinitions.push([
      `db.buffer.logical.${direction}`,
      `buffer_pool_logical_${suffix}_total`,
      "operations_per_second",
      "operations",
      "pool",
      { pool }
    ]);
    databaseDefinitions.push([
      `db.buffer.physical.${direction}`,
      `buffer_pool_os_${suffix}_total`,
      "blocks_per_second",
      "blocks",
      "pool",
      { pool }
    ]);
  }
}
databaseDefinitions.push(
  ["db.bi.write.blocks", "bi_blocks_written_total", "blocks_per_second", "blocks", "bi", {}],
  ["db.bi.write.bytes", "bi_bytes_written_total", "bytes_per_second", "bytes", "bi", {}]
);
for (const operation of ["read", "write"])
  databaseDefinitions.push([
    "db.bi.io",
    "bi_io_operations_total",
    "operations_per_second",
    "operations",
    "bi",
    { operation }
  ]);
export const DATABASE_SUMMARY_CATALOG: DatabaseMetricDefinition[] = databaseDefinitions.map(
  ([definitionId, suffix, rateOrLevelUnit, totalUnit, coverageScope, selectorDimensions], i) => ({
    definitionId,
    displayName: definitionId.replaceAll(".", " "),
    group: "database",
    sourceMetricNames: [`parkbench_openedge_db_${suffix}`],
    type: "counter",
    sourceUnit: totalUnit,
    rateOrLevelUnit,
    totalUnit,
    coverageScope,
    allowedDimensions: ["table", "pool", "operation"],
    required: false,
    supportedStatistics: ["average", "p90", "p95", "total"],
    authoritativePublisher: "native_db_endpoint",
    sourceContractVersion: "openedge-db.v3",
    catalogOrder: 100 + i,
    selectorDimensions
  })
);
