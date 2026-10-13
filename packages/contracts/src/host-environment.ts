import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "./schema-loader";

export const HOST_ENVIRONMENT_CONTRACT_VERSION = "host-environment.v1" as const;

export type HostCheckStatus = "pass" | "fail" | "warning";

export interface HostEnvironmentCheck {
  id: string;
  status: HostCheckStatus;
  diagnosticCode: string;
  action: string;
  observed?: string | number | boolean | null;
}

export interface HostEnvironmentProfile {
  contractVersion: typeof HOST_ENVIRONMENT_CONTRACT_VERSION;
  capturedAt: string;
  status: "ready" | "blocked";
  host: {
    osId: string;
    osRelease: string;
    codename: string;
    kernel: string;
    architecture: string;
  };
  toolchain: {
    node: string;
    npm: string | null;
    dockerClient: string | null;
    compose: string | null;
    compilerAdapterVersion: string | null;
  };
  engine: {
    reachable: boolean;
    contextName: string | null;
    serverVersion: string | null;
    operatingSystem: string | null;
    architecture: string | null;
    endpointKind: "local-unix-socket" | "unsupported" | null;
  };
  checks: HostEnvironmentCheck[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile<HostEnvironmentProfile>(loadContractSchema("host-environment-v1"));

export function validateHostEnvironmentProfile(input: unknown): HostEnvironmentProfile {
  if (!validate(input)) throw new Error("host_environment_profile_invalid");
  const profile = input as HostEnvironmentProfile;
  if (profile.status === "ready") {
    if (
      profile.host.osId !== "ubuntu" ||
      profile.host.osRelease !== "26.04.1 LTS" ||
      profile.host.codename !== "resolute" ||
      profile.host.architecture !== "x86_64" ||
      Number.parseInt(profile.toolchain.node.split(".")[0], 10) < 24
    )
      throw new Error("host_environment_supported_profile_mismatch");
    if (!profile.engine.reachable || profile.checks.some((check) => check.status === "fail"))
      throw new Error("host_environment_ready_checks_incomplete");
    for (const checkId of ["node_version", "docker_engine_access", "compose_config"]) {
      if (!profile.checks.some((check) => check.id === checkId && check.status === "pass"))
        throw new Error("host_environment_required_check_missing");
    }
  }
  return profile;
}
