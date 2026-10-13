import { generatedFiles } from "../../packages/dashboards/src";

export interface GeneratedPanel {
  dashboard: any;
  row?: string;
  panel: any;
}

/** Generated v2 dashboards keyed by UID, straight from the builder. */
export function generatedDashboards(): Record<string, any> {
  const dashboards: Record<string, any> = {};
  for (const [file, content] of Object.entries(generatedFiles()))
    if (file.endsWith(".json")) {
      const dashboard = JSON.parse(content);
      dashboards[dashboard.uid] = dashboard;
    }
  return dashboards;
}

/** Every non-row panel with the title of the row it belongs to. */
export function panelsOf(dashboard: any): GeneratedPanel[] {
  const output: GeneratedPanel[] = [];
  let row: string | undefined;
  for (const panel of dashboard.panels) {
    if (panel.type === "row") {
      row = panel.title;
      for (const child of panel.panels ?? []) output.push({ dashboard, row, panel: child });
    } else output.push({ dashboard, row, panel });
  }
  return output;
}

export function rowsOf(dashboard: any): string[] {
  return dashboard.panels
    .filter((panel: any) => panel.type === "row")
    .map((panel: any) => panel.title);
}

export function panelById(dashboard: any, id: string): any {
  return panelsOf(dashboard).find((entry) => entry.panel.parkbench?.panelId === id)?.panel;
}

/** Substitutes Grafana variables so an expression can be evaluated by Prometheus. */
export function interpolate(expr: string, runs: string[], rangeSeconds: number): string {
  const runRegex = runs.length === 1 ? runs[0] : `(${runs.join("|")})`;
  return expr
    .replaceAll("$__rate_interval", "30s")
    .replaceAll("$__range", `${rangeSeconds}s`)
    .replaceAll("$run_id", runRegex)
    .replaceAll("$picker_run", runs[0] ?? "")
    .replaceAll("$disk_exclude", "(loop|ram|zram|fd|sr|dm-|md).*")
    .replaceAll(
      "$interface_exclude",
      "lo|docker.*|br-.*|veth.*|virbr.*|cni.*|flannel.*|cali.*|vxlan.*|tun.*|tap.*|wg.*"
    );
}

/** Replacement-only fixture files; legacy/root copies never enter the same reader. */
export function stagedDashboardFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(generatedFiles())
      .filter(([file]) => file.endsWith(".json"))
      .map(([file, content]) => [file.replace("deploy/grafana/dashboards/", ""), content])
  );
}
