import { DASHBOARD_UIDS, DASHBOARD_TITLES, DashboardDefinition, Row } from "../model";
import { namedLatchPanels, databaseConcurrencyPanels } from "../queries/database-concurrency";
import { noticePanels } from "./definitions";
export function concurrencyDashboard(): DashboardDefinition {
  const panels = databaseConcurrencyPanels();
  const rows: Row[] = [{ name: "Notices", collapsed: false, panels: noticePanels() }];
  rows.push({
    name: "Transactions",
    collapsed: false,
    panels: panels.filter((p) => [36, 37, 38, 39].includes(p.legacy?.panelId ?? -1))
  });
  rows.push({
    name: "Record and buffer locks",
    collapsed: true,
    panels: panels.filter((p) => [11, 12].includes(p.legacy?.panelId ?? -1))
  });
  rows.push({ name: "Named latch waits", collapsed: false, panels: namedLatchPanels() });
  rows.push({
    name: "Aggregate latches",
    collapsed: true,
    panels: panels.filter((p) => [40, 41, 42, 43, 44, 45].includes(p.legacy?.panelId ?? -1))
  });
  rows.push({
    name: "Lock operations",
    collapsed: true,
    panels: panels.filter((p) =>
      [46, 47, 48, 49, 50, 51, 52, 53, 54].includes(p.legacy?.panelId ?? -1)
    )
  });
  return {
    uid: DASHBOARD_UIDS.concurrency,
    title: DASHBOARD_TITLES.concurrency,
    kind: "diagnostic",
    datasource: "parkbench_runs",
    runSelection: "multi",
    rows,
    retires: [],
    tags: ["parkbench", "concurrency"],
    filters: ["phase"]
  };
}
