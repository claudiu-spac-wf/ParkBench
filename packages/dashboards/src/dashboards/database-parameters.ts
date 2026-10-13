import { DASHBOARD_UIDS, DASHBOARD_TITLES, DashboardDefinition, Row } from "../model";
import { parametersPanels } from "../queries/parameters";
import { noticePanels } from "./definitions";
export function parametersDashboard(): DashboardDefinition {
  const panels = parametersPanels();
  const rows: Row[] = [{ name: "Notices", collapsed: false, panels: noticePanels() }];
  rows.push({ name: "Startup snapshot", collapsed: false, panels: panels });
  return {
    uid: DASHBOARD_UIDS.parameters,
    title: DASHBOARD_TITLES.parameters,
    kind: "snapshot",
    datasource: "parkbench_runs",
    runSelection: "multi",
    rows,
    retires: [],
    tags: ["parkbench", "parameters"],
    filters: []
  };
}
