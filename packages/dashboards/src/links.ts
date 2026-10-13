import { DASHBOARD_TITLES, DASHBOARD_UIDS } from "./model";

export const WEB_URL_VAR = "parkbench_web_url";
export const DEFAULT_WEB_URL = "http://127.0.0.1:13002";

type DashboardKey = keyof typeof DASHBOARD_UIDS;

/**
 * Shared link bar (FR-024a). Every link goes through the control-plane redirect, which
 * carries the time range and runs as the contract requires; `includeVars` passes
 * `var-run_id` / `var-picker_run`, and `keepTime` passes `from`/`to`.
 */
export function linkBar(self: DashboardKey, runScoped: boolean): Record<string, unknown>[] {
  const links: Record<string, unknown>[] = (Object.keys(DASHBOARD_UIDS) as DashboardKey[])
    .filter((key) => key !== self)
    .map((key) => ({
      title: DASHBOARD_TITLES[key],
      type: "link",
      icon: "dashboard",
      tooltip: `Open ${DASHBOARD_TITLES[key]} with the current time range and runs`,
      url: `\${${WEB_URL_VAR}}/api/v1/grafana/open?dashboard=${DASHBOARD_UIDS[key]}`,
      includeVars: true,
      keepTime: true,
      targetBlank: false,
      asDropdown: false,
      tags: []
    }));
  if (runScoped)
    links.push({
      title: "Reset range to selected runs",
      type: "link",
      icon: "sync",
      tooltip: "Recalculate the time range and mode for the selected runs",
      url: `\${${WEB_URL_VAR}}/api/v1/grafana/open?dashboard=${DASHBOARD_UIDS[self]}&reset=1`,
      includeVars: true,
      keepTime: false,
      targetBlank: false,
      asDropdown: false,
      tags: []
    });
  return links;
}
