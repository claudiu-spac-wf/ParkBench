import { DASHBOARD_UIDS, DASHBOARD_TITLES, DashboardDefinition, Row } from "../model";
import { databaseRecoveryPanels } from "../queries/database-recovery";
import { noticePanels } from "./definitions";
export function recoveryDashboard(): DashboardDefinition {
  const panels = databaseRecoveryPanels();
  const rows: Row[] = [{ name: "Notices", collapsed: false, panels: noticePanels() }];
  rows.push({
    name: "Checkpoints",
    collapsed: false,
    panels: panels.filter(
      (p) =>
        p.legacy?.uid === "parkbench-database-activity" ||
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(p.legacy?.panelId ?? -1)
    )
  });
  rows.push({
    name: "Before image",
    collapsed: true,
    panels: panels.filter(
      (p) =>
        p.legacy?.uid !== "parkbench-database-activity" &&
        [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].includes(p.legacy?.panelId ?? -1)
    )
  });
  rows.push({
    name: "Page writers",
    collapsed: true,
    panels: panels.filter((p) =>
      [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35].includes(p.legacy?.panelId ?? -1)
    )
  });
  return {
    uid: DASHBOARD_UIDS.recovery,
    title: DASHBOARD_TITLES.recovery,
    kind: "diagnostic",
    datasource: "parkbench_runs",
    runSelection: "multi",
    rows,
    retires: [],
    tags: ["parkbench", "recovery"],
    filters: ["phase"]
  };
}
