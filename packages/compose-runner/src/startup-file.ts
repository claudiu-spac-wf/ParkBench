import {
  databaseParameterDefinition,
  databaseParameterOptions,
  validateDatabaseParameterValue,
  databaseParameterInput
} from "../../contracts/src/database-parameter-options";
import { parseDatabaseParameterFile } from "../../contracts/src/database-startup";
export interface StartupFileEntry {
  name: string;
  value: string;
  line: number;
  sourceFile?: string;
}
export interface ParsedStartupFile {
  status: "absent" | "valid";
  entries: StartupFileEntry[];
  parameters: StartupFileEntry[];
}
export const DATABASE_BROKER_PARAMETERS = new Set(
  databaseParameterOptions().parameters.flatMap((p) => [p.name, ...p.aliases])
);
export function validateBrokerParameter(name: string, value: string, line?: number): void {
  const p = databaseParameterDefinition(name);
  try {
    if (
      !p ||
      p.scope !== "primary_database_broker" ||
      p.ownership.rule === "managed_infrastructure" ||
      p.unavailableReason
    )
      throw new Error("context");
    validateDatabaseParameterValue(name, databaseParameterInput(name, value));
    if (
      p.name === "-pf" &&
      (value.split("/").includes("..") ||
        (value.startsWith("/") &&
          !value.startsWith("/run/parkbench/seed/db/") &&
          !/^\/psc\/wrk\/[^/]+\//.test(value)))
    )
      throw new Error("ownership");
  } catch {
    throw new Error(`database_startup_file_invalid:${name}${line === undefined ? "" : `:${line}`}`);
  }
}
export function parseStartupFile(content: string | null): ParsedStartupFile {
  if (content === null) return { status: "absent", entries: [], parameters: [] };
  parseDatabaseParameterFile(content);
  const entries: StartupFileEntry[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const words = parseDatabaseParameterFile(line);
    for (let i = 0; i < words.length;) {
      const raw = words[i],
        p = databaseParameterDefinition(raw);
      if (!p) throw new Error(`database_startup_file_invalid:${raw}:${index + 1}`);
      const value = p.valueKind === "presence_flag" ? "true" : words[i + 1];
      if (value === undefined) throw new Error(`database_startup_file_invalid:${raw}:${index + 1}`);
      validateBrokerParameter(raw, value, index + 1);
      entries.push({ name: p.name, value, line: index + 1 });
      i += p.argumentCount + 1;
    }
  }
  const winners = new Map<string, StartupFileEntry>();
  for (const e of entries) winners.set(e.name, e);
  return { status: "valid", entries, parameters: [...winners.values()] };
}
