import type { HostEnvironmentProfile } from "../packages/contracts/src/host-environment";

export interface HostPreflightCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface HostPreflightDependencies {
  root?: string;
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  architecture?: string;
  kernel?: string;
  osReleaseText?: string;
  freeBytes?: number;
  now?: () => Date;
  runCommand?: (
    command: string,
    args: string[],
    options?: { cwd?: string }
  ) => HostPreflightCommandResult;
  portInUse?: (host: string, port: number) => boolean | Promise<boolean>;
}

export function collectHostEnvironment(
  dependencies?: HostPreflightDependencies
): Promise<HostEnvironmentProfile>;
export function sanitizeVersion(value: string): string | null;
