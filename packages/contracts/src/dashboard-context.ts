export { DashboardContext } from "./control-ui";

export interface DashboardContextRequest {
  experimentId?: string;
  runIds: string[];
  baselineRunId?: string;
  phase?: string;
  metricScope?: string[];
}
