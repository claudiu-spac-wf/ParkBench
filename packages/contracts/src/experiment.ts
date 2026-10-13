import { ScenarioRef } from "./scenario";
export type ComparisonMode = "comparative" | "exploratory";
export interface Variant {
  id: string;
  name: string;
  parameters: Record<string, string | number | boolean>;
  databaseStartup?: import("./database-startup").DatabaseStartupParameters;
  databaseRunControls?: import("./database-run-controls").DatabaseRunControls;
}
export interface ExperimentInputRefs {
  databaseImage: string;
  pasImage: string;
  /** Resolved seed folder (an on-disk database) or an `input:seeds/<name>` reference. */
  seed: string;
  /** Recorded from the selected seed folder at submission (feature 014). */
  seedName?: string;
  databaseName?: string;
  applicationArchive: string;
  credentialRef?: string;
}
export interface ExperimentRequest {
  scheduleName?: string;
  scenario: ScenarioRef;
  comparisonMode: ComparisonMode;
  baselineVariantId?: string;
  repetitions: number;
  variants: Variant[];
  inputs: ExperimentInputRefs;
}
export interface ExperimentScheduleV2Request {
  contractVersion: "experiment-schedule.v2";
  runName: string;
  scenarioSourceId: string;
  dimensions: Array<{ name: string; values: Array<string | number | boolean> }>;
  repetitions: number;
  inputs: Pick<ExperimentInputRefs, "seed" | "applicationArchive">;
}
export type ExperimentStatus =
  "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED" | "INTERRUPTED";
export interface Experiment extends ExperimentRequest {
  id: string;
  status: ExperimentStatus;
  runIds: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
