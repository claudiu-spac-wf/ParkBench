import { api } from "../../api";
import {
  DatabaseSetupEvidence,
  DatabaseSetup
} from "../../../../../packages/contracts/src/database-setup";
export type SetupView = DatabaseSetupEvidence & {
  configuration?: DatabaseSetup;
  artifacts?: Array<{ id: string; path: string; url: string }>;
};
export const getDatabaseSetup = (runId: string) =>
  api<SetupView>(`/runs/${encodeURIComponent(runId)}/database-setup`);
