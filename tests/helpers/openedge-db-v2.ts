import {
  OPENEDGE_DB_FAMILY_NAMES,
  OPENEDGE_DB_FAMILY_SOURCES,
  OPENEDGE_DB_METRIC_CATALOG,
  databaseEpoch,
  getOpenEdgeDbAvailabilityTuples,
  setOpenEdgeDbLabelSet
} from "../../packages/contracts/src/openedge";

/**
 * Metric label sets of the database these observer fixtures were captured from. Runs get their
 * label sets from the collector, which reads the run database's metaschema (feature 014); tests
 * register this fixture database's.
 */
export const FIXTURE_DB_LABELS = {
  tables: ["Customer", "Item", "Order", "OrderLine"],
  indexes: [
    "Customer.CustNum", "Customer.Comments", "Customer.CountryPost", "Customer.Name",
    "Customer.SalesRep", "Item.ItemNum", "Item.CatDescription", "Item.Category2ItemName",
    "Item.CategoryItemName", "Item.ItemName", "Order.OrderNum", "Order.CustOrder",
    "Order.OrderDate", "Order.OrderStatus", "Order.SalesRep", "OrderLine.OrderLine",
    "OrderLine.ItemNum", "OrderLine.OrderLineStatus"
  ]
};
setOpenEdgeDbLabelSet(FIXTURE_DB_LABELS);

export function completeOpenEdgeDbPayload(): any {
  return {
    protocolVersion: 2,
    database: {
      productVersion: "12.8.12.0.2000",
      startedAt: "2026-09-24T09:00:00Z",
      statisticsResetAt: "2026-09-24T09:00:00Z"
    },
    collectedAt: "2026-09-24T10:00:00Z",
    families: OPENEDGE_DB_FAMILY_NAMES.map((name) => ({
      name,
      sources: [...OPENEDGE_DB_FAMILY_SOURCES[name]],
      measurements: OPENEDGE_DB_METRIC_CATALOG.filter((definition) => definition.family === name)
        .flatMap((definition) =>
          getOpenEdgeDbAvailabilityTuples(definition).map((labels) => ({
            name: definition.name,
            availability: "not_collected",
            source: definition.sources[0],
            reason: "not_applicable",
            labels
          }))
        )
    })),
    metrics: []
  };
}

export function addAvailableTableSample(payload: any, table: string, value: number): void {
  const family = payload.families.find((item: any) => item.name === "table_activity");
  const measurement = family.measurements.find(
    (item: any) =>
      item.name === "table_operations_total" &&
      item.labels.table === table &&
      item.labels.operation === "read"
  );
  if (!measurement) throw new Error("openedge_fixture_table_tuple_missing");
  measurement.availability = "available";
  measurement.reason = "available";
  measurement.source = "_TableStat";
  payload.metrics.push({
    name: "table_operations_total",
    type: "counter",
    unit: "table operations",
    value,
    source: "_TableStat",
    labels: {
      table,
      operation: "read",
      database_epoch: databaseEpoch(
        payload.database.startedAt,
        payload.database.statisticsResetAt
      )
    }
  });
}

export function fixtureCollectorSnapshot(): any {
  return {
    protocolVersion: 2,
    database: {
      productVersion: "12.8.11.0.1274",
      startedAt: "2026-09-24T09:00:00Z",
      statisticsResetAt: "2026-09-24T09:30:00+03:00"
    },
    collectedAt: "2026-09-24T10:00:00Z",
    unavailableSources: [],
    snapshot: {
      _DbStatus: [
        {
          "_DbStatus-OEVersion": "12.8.11.0.1274",
          "_DbStatus-starttime": " 2026-09-24T09:00:00Z ",
          "_DbStatus-ZeroStatsDate-TZ": " 2026-09-24T09:30:00+03:00 ",
          "_DbStatus-ZeroStatsDate": "2026-09-24T06:30:00Z",
          "_DbStatus-BiSize": 16,
          "_DbStatus-BiBlkSize": 8192,
          "_DbStatus-BiClSize": 128
        }
      ],
      _DbParams: [
        { parameter: "-B", "_DbParams-Value": "3000" },
        { parameter: "-B2", "_DbParams-Value": "0" },
        { parameter: "-bithold", "_DbParams-Value": "5" },
        { parameter: "-basetable", "_DbParams-Value": "1" },
        { parameter: "-tablerangesize", "_DbParams-Value": "50" },
        { parameter: "-baseindex", "_DbParams-Value": "1" },
        { parameter: "-indexrangesize", "_DbParams-Value": "50" }
      ],
      _ActBuffer: [
        {
          pool: "primary",
          "_Buffer-LogicRds": 10,
          "_Buffer-OSRds": 2,
          "_Buffer-LogicWrts": 7,
          "_Buffer-OSWrts": 1,
          "_Buffer-Active": 80,
          "_Buffer-Free": 10,
          "_Buffer-Deferred": 3,
          "_Buffer-Flushed": 4,
          "_Buffer-Marked": 5,
          "_Buffer-LRUSkips": 6,
          "_Buffer-LRUwrts": 7,
          "_Buffer-APWEnq": 8,
          "_Buffer-Chkpts": 9
        },
        {
          pool: "alternate",
          "_Buffer-LogicRds": 0,
          "_Buffer-OSRds": 0,
          "_Buffer-LogicWrts": 0,
          "_Buffer-OSWrts": 0,
          "_Buffer-Active": 0,
          "_Buffer-Free": 0,
          "_Buffer-Deferred": 0,
          "_Buffer-Flushed": 0,
          "_Buffer-Marked": 0,
          "_Buffer-LRUSkips": 0,
          "_Buffer-LRUwrts": 0,
          "_Buffer-APWEnq": 0,
          "_Buffer-Chkpts": 0
        }
      ],
      _ActSummary: [
        {
          "_Summary-Commits": 11,
          "_Summary-Undos": 2,
          "_Summary-RecReads": 20,
          "_Summary-RecUpd": 3,
          "_Summary-RecCreat": 4,
          "_Summary-RecDel": 1,
          "_Summary-RecLock": 5,
          "_Summary-RecWait": 6,
          "_Summary-DbReads": 10,
          "_Summary-DbWrites": 7,
          "_Summary-Chkpts": 2,
          "_Summary-Flushed": 3,
          "_Summary-DbAccesses": 8
        }
      ],
      _TableStat: [
        { table: "Customer", "_TableStat-create": 1, "_TableStat-read": 5, "_TableStat-update": 2, "_TableStat-delete": 1, "_TableStat-OsRead": 3 },
        { table: "other", "_TableStat-create": 3, "_TableStat-read": 7, "_TableStat-update": 1, "_TableStat-delete": 2, "_TableStat-OsRead": 4 }
      ],
      _IndexStat: [
        { index: "Customer.CustNum", "_IndexStat-create": 1, "_IndexStat-read": 4, "_IndexStat-delete": 2, "_IndexStat-blockdelete": 3, "_IndexStat-split": 1, "_IndexStat-OsRead": 8 },
        { index: "other", "_IndexStat-create": 0, "_IndexStat-read": 2, "_IndexStat-delete": 1, "_IndexStat-blockdelete": 1, "_IndexStat-split": 0, "_IndexStat-OsRead": 2 }
      ],
      _Checkpoint: [
        { "_Checkpoint-Number": 4, "_Checkpoint-Duration": 1, "_Checkpoint-Bi-Write-Time": 0.1, "_Checkpoint-B-Write-Time": 0.2, "_Checkpoint-SyncTime": 0.3, "_Checkpoint-Buffers": 10, "_Checkpoint-Dirty": 3, "_Checkpoint-Flush": 1, "_Checkpoint-ApwQ": 2, "_Checkpoint-CptQ": 3, "_Checkpoint-Scan": 4 },
        { "_Checkpoint-Number": 5, "_Checkpoint-Duration": 2, "_Checkpoint-Bi-Write-Time": 0.4, "_Checkpoint-B-Write-Time": 0.5, "_Checkpoint-SyncTime": 0.6, "_Checkpoint-Buffers": 11, "_Checkpoint-Dirty": 4, "_Checkpoint-Flush": 2, "_Checkpoint-ApwQ": 3, "_Checkpoint-CptQ": 4, "_Checkpoint-Scan": 5 }
      ],
      _ActPWs: [
        { "_PW-TotDBWrites": 9, "_PW-DBWrites": 4, "_PW-ScanWrites": 5, "_PW-ApwQWrites": 6, "_PW-CkpQWrites": 2, "_PW-ScanCycles": 3, "_PW-BuffsScaned": 7, "_PW-BufsCkp": 8, "_PW-Marked": 9, "_PW-Flushed": 10, "_PW-UpTime": 600 }
      ],
      _ActBILog: [{ "_BiLog-TotalWrts": 7, "_BiLog-BytesWrtn": 56 }],
      _Logging: [{ "_Logging-BiIO": "Reliable", "_Logging-BiBuffs": 64, "_Logging-BiFullBuffs": 0, "_Logging-BiBytesFree": 4096 }],
      _ActIOType: [{ "_IOType-IdxRds": 2, "_IOType-IdxWrts": 1, "_IOType-DataReads": 3, "_IOType-DataWrts": 4, "_IOType-BiRds": 5, "_IOType-BiWrts": 6 }],
      _ActLock: [{ "_Lock-ExclLock": 8, "_Lock-RecGetReq": 7, "_Lock-ShrReq": 6, "_Lock-UpgReq": 5, "_Lock-ExclReq": 9, "_Lock-RecGetLock": 8, "_Lock-ShrLock": 7, "_Lock-UpgLock": 6, "_Lock-ExclWait": 4, "_Lock-RecGetWait": 3, "_Lock-ShrWait": 2, "_Lock-UpgWait": 1, "_Lock-ExclFind": 10, "_Lock-ShrFind": 11, "_Lock-CanclReq": 12, "_Lock-Downgrade": 13, "_Lock-RedReq": 14 }],
      _Latch: [
        { "_Latch-Busy": 1, "_Latch-Lock": 2, "_Latch-Wait": 3, "_Latch-Spin": 4, "_Latch-LockT": 1_000_000, "_Latch-WaitT": 2_000_000 },
        { "_Latch-Busy": 2, "_Latch-Lock": 3, "_Latch-Wait": 4, "_Latch-Spin": 5, "_Latch-LockT": 500_000, "_Latch-WaitT": 1_000_000 }
      ],
      _Trans: [{ "_Trans-Duration": 5 }, { "_Trans-Duration": 10 }]
    }
  };
}
