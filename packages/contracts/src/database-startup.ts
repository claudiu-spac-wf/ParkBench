import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "./schema-loader";

export const DATABASE_STARTUP_CONTRACT_VERSION = "db-startup-parameters.v1" as const;

export type DatabaseParameterSource = "queued" | "scenario" | "startup_file";
export type DatabaseParameterVerification = "pending" | "matched" | "mismatched" | "unverifiable";

export interface DatabaseStartupParameter {
  name: string;
  displayValue: string;
  source: DatabaseParameterSource;
  overrides: DatabaseParameterSource[];
  sourceReference?: string;
  applicability: "database_broker";
  verification: DatabaseParameterVerification;
  observedValue?: string | null;
  reason?: string;
}

export interface DatabaseStartupParameters {
  contractVersion: typeof DATABASE_STARTUP_CONTRACT_VERSION;
  databaseName: string;
  registryVersion?: string;
  /** Controller-verified PF references whose arguments are frozen in parameters. */
  expandedParameterFiles?: string[];
  startupFile:
    { status: "absent" } | { status: "present"; relativePath: "startup.pf" | "db/startup.pf" };
  parameters: DatabaseStartupParameter[];
}

const validate = new Ajv({ allErrors: true, strict: false }).compile<DatabaseStartupParameters>(
  loadContractSchema("database-startup-v1")
);

export function validateDatabaseStartupParameters(input: unknown): DatabaseStartupParameters {
  if (!validate(input))
    throw new Error(`database_startup_invalid:${JSON.stringify(validate.errors)}`);
  const startup = input as DatabaseStartupParameters;
  const names = new Set<string>();
  for (const parameter of startup.parameters) {
    if (names.has(parameter.name))
      throw new Error(`database_startup_duplicate_parameter:${parameter.name}`);
    names.add(parameter.name);
  }
  return startup;
}

/** Native UNIX PF lexer. Parameters and their values must remain on the same line. */
export function parseDatabaseParameterFile(content: string): string[] {
  if (new TextEncoder().encode(content).length > 64 * 1024 || content.includes("\0"))
    throw new Error("database_startup_file_invalid:size_or_nul");
  const result: string[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (Array.from(line).length > 256 || line.includes("\r"))
      throw new Error(`database_startup_file_invalid:line_length:${index + 1}`);
    let token = "",
      quote = "",
      active = false;
    const words: string[] = [];
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") {
        if (++i >= line.length)
          throw new Error(`database_startup_file_invalid:escape:${index + 1}`);
        const next = line[i];
        const escapes: Record<string, string> = {
          b: "\b",
          t: "\t",
          n: "\n",
          r: "\r",
          f: "\f",
          E: "\x1b"
        };
        if (/[0-7]/.test(next)) {
          const octal = line.slice(i).match(/^[0-7]{1,3}/)![0];
          token += String.fromCharCode(parseInt(octal, 8));
          i += octal.length - 1;
        } else token += escapes[next] ?? next;
        active = true;
        continue;
      }
      if (!quote && c === "#") break;
      if (!quote && /\s/.test(c)) {
        if (active) {
          words.push(token);
          token = "";
          active = false;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        if (quote === c) {
          quote = "";
          continue;
        }
        if (!quote) {
          quote = c;
          active = true;
          continue;
        }
      }
      token += c;
      active = true;
    }
    if (quote) throw new Error(`database_startup_file_invalid:quote:${index + 1}`);
    if (active) words.push(token);
    if (words.length > 40)
      throw new Error(`database_startup_file_invalid:token_count:${index + 1}`);
    if (words.some((w) => /[\0\r\n]/.test(w)))
      throw new Error(`database_startup_file_invalid:literal_argv_transport:${index + 1}`);
    result.push(...words);
  }
  return result;
}
