import { DASHBOARD_UIDS, DASHBOARD_TITLES, DashboardDefinition, Row } from "../model";
import { databaseActivityPanels } from "../queries/database-activity";
import { noticePanels } from "./definitions";
export function activityDashboard(): DashboardDefinition {
  const panels = databaseActivityPanels();
  const rows: Row[] = [{ name: "Notices", collapsed: false, panels: noticePanels() }];
  rows.push({ name: "Table overview", collapsed: false, panels: panels.filter((p) => !p.legacy) });
  rows.push({
    name: "Buffer pools",
    collapsed: true,
    panels: panels.filter((p) =>
      [1, 2, 3, 4, 5, 6, 17, 18, 19, 20, 21].includes(p.legacy?.panelId ?? -1)
    )
  });
  rows.push({
    name: "Objects",
    collapsed: true,
    panels: panels.filter((p) => [7, 8, 9, 10].includes(p.legacy?.panelId ?? -1))
  });
  rows.push({
    name: "Block I/O",
    collapsed: true,
    panels: panels.filter((p) => [13, 14, 15].includes(p.legacy?.panelId ?? -1))
  });
  return {
    uid: DASHBOARD_UIDS.activity,
    title: DASHBOARD_TITLES.activity,
    kind: "diagnostic",
    datasource: "parkbench_runs",
    runSelection: "multi",
    rows,
    retires: [],
    tags: ["parkbench", "activity"],
    filters: ["phase", "table", "index"]
  };
}
