import { DASHBOARD_UIDS, DASHBOARD_TITLES, DashboardDefinition, Row } from "../model";
import { pasPanels } from "../queries/pas";
import { noticePanels } from "./definitions";
export function pasDashboard(): DashboardDefinition {
  const panels = pasPanels();
  const rows: Row[] = [{ name: "Notices", collapsed: false, panels: noticePanels() }];
  rows.push({
    name: "Summary",
    collapsed: false,
    panels: panels.filter((p) => (p.legacy?.panelId ?? 0) < 5)
  });
  for (const [name, id] of [
    ["CPU", 5],
    ["Memory", 6],
    ["Disk", 7],
    ["Network", 8]
  ] as const)
    rows.push({ name, collapsed: true, panels: panels.filter((p) => p.legacy?.panelId === id) });
  return {
    uid: DASHBOARD_UIDS.pas,
    title: DASHBOARD_TITLES.pas,
    kind: "diagnostic",
    datasource: "parkbench_runs",
    runSelection: "multi",
    rows,
    retires: [],
    tags: ["parkbench", "pas"],
    filters: ["phase", "replica"]
  };
}
