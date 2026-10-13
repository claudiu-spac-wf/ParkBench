import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CatalogAsset } from "../../../../packages/contracts/src";
import { redactSecrets } from "../../../../packages/contracts/src/redaction";
import {
  parseImageReference,
  parseImageTag
} from "../../../../packages/contracts/src/image-reference";
import { ControlledImageRunner } from "./image-operation-runner";

const execFileAsync = promisify(execFile);
const allowedProfiles = new Set(["workload", "loadgen", "database", "pas", "observer"]);

export class DockerImageRunner implements ControlledImageRunner {
  constructor(
    private readonly inspect: (image: string) => Promise<boolean>,
    private readonly options: { testMode?: boolean; managedRoot?: string } = {}
  ) {}

  async verify(input: {
    assets: CatalogAsset[];
    expectedContracts: string[];
    signal?: AbortSignal;
  }): Promise<{
    diagnostics: string[];
  }> {
    for (const asset of input.assets) {
      if (!isImageAsset(asset)) continue;
      const reference = String(asset.provenance?.reference ?? asset.immutableRef ?? "");
      if (!reference || reference.startsWith("input:")) continue;
      parseImageReference(reference);
      if (input.signal?.aborted) throw new Error("image_operation_cancelled");
      if (!(await this.inspect(reference))) throw new Error(`image_not_inspectable:${reference}`);
    }
    return {
      diagnostics: [
        `verified ${input.assets.length} approved asset(s)`,
        input.expectedContracts.length
          ? `contracts: ${input.expectedContracts.join(",")}`
          : "contracts: none declared"
      ].map((line) => String(redactSecrets(line)))
    };
  }

  async build(input: {
    assets: CatalogAsset[];
    stage?: string;
    outputProfile?: string;
    operationId?: string;
    signal?: AbortSignal;
  }): Promise<{ reference?: string; diagnostics: string[] }> {
    const profile = input.outputProfile ?? "database";
    if (!allowedProfiles.has(profile)) throw new Error(`image_profile_not_allowed:${profile}`);
    if (this.options.testMode) {
      return {
        reference: `parkbench/${profile}:fixture`,
        diagnostics: [`fake controlled build completed for ${profile}`]
      };
    }

    const source = input.assets.find((asset) => {
      const provenance = asset.provenance ?? {};
      return typeof provenance.contextPath === "string";
    });
    const contextPath = String(source?.provenance?.contextPath ?? "");
    if (!contextPath) throw new Error("image_build_context_required");
    const managedRoot = path.resolve(this.options.managedRoot ?? process.cwd());
    const resolvedContext = path.resolve(contextPath);
    if (resolvedContext !== managedRoot && !resolvedContext.startsWith(`${managedRoot}${path.sep}`))
      throw new Error("image_build_context_outside_managed_root");
    if (!fs.existsSync(path.join(resolvedContext, "Dockerfile")))
      throw new Error("image_build_dockerfile_missing");

    const configuredTag = process.env.PARKBENCH_IMAGE_TAG;
    const tag = `parkbench/control-ui-${profile}:${configuredTag ? parseImageTag(configuredTag) : (input.operationId ?? "build")}`;
    const result = await execFileAsync(
      "docker",
      ["build", "--pull=false", "--target", input.stage ?? "final", "--tag", tag, resolvedContext],
      input.signal ? { signal: input.signal } : undefined
    );
    return {
      reference: tag,
      diagnostics: [
        String(redactSecrets(`docker build completed for ${profile}`)),
        String(redactSecrets(result.stderr)).slice(-4000)
      ].filter(Boolean)
    };
  }
}

function isImageAsset(asset: CatalogAsset): boolean {
  return (
    ["database_image", "pas_image", "loadgen_image", "observer_image", "docker_image"].includes(
      asset.kind
    ) || asset.provenance?.source === "docker"
  );
}
