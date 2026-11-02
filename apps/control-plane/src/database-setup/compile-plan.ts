import { stageSetupScripts } from "./stage-scripts";
import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSetup,
  DatabaseSetupManifest,
  validateDatabaseSetup
} from "../../../../packages/contracts/src/database-setup";

/** Quotes one literal token for generated container-only shell files. Never executed on the host. */
export const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
export const setupOrdinal = (index: number): string => String(index + 1).padStart(4, "0");
export interface CompileDatabaseSetupInput {
  runId: string;
  attemptId: string;
  setup: DatabaseSetup;
  runtimeDirectory: string;
  databaseName: string;
  image: string;
  scriptsRoot?: string;
  containerInputRoot?: string;
  containerHelpersPath?: string;
}
export function compileDatabaseSetup(input: CompileDatabaseSetupInput) {
  if (![input.runId, input.attemptId, input.databaseName].every((v) => /^[a-zA-Z0-9_-]+$/.test(v)))
    throw new Error("database_setup_invalid:runtime_identity");
  const sequence = structuredClone(validateDatabaseSetup(input.setup));
  const root = path.join(input.runtimeDirectory, "database-setup", input.attemptId);
  const paths = {
    input: path.join(root, "input"),
    output: path.join(root, "output"),
    control: path.join(root, "control")
  };
  if (fs.existsSync(path.join(paths.input, "manifest.json")))
    throw new Error("database_setup_replay_refused:plan_exists");
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  for (const dir of [paths.output, paths.control]) fs.chmodSync(dir, 0o777);
  const manifest: DatabaseSetupManifest = {
    contractVersion: "database-setup-manifest.v1",
    runId: input.runId,
    attemptId: input.attemptId,
    sequence,
    capturedAt: new Date().toISOString(),
    databaseName: input.databaseName,
    databaseDirectory: `/psc/wrk/${input.databaseName}`,
    image: input.image,
    maintenanceArguments: [
      input.databaseName,
      "-cpinternal",
      "UTF-8",
      "-S",
      "20931",
      "-minport",
      "20932",
      "-maxport",
      "20941"
    ],
    scripts: [],
    paths
  };
  stageSetupScripts(manifest, input.scriptsRoot);
  const write = (name: string, text: string) => {
    const target = path.join(paths.input, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, { mode: 0o644, flag: "wx" });
  };
  write(
    "identity.sh",
    `setup_run_id=${shellQuote(input.runId)}\nsetup_attempt_id=${shellQuote(input.attemptId)}\nsetup_step_count=${sequence.steps.length}\nsetup_custom_requested=${sequence.steps.some((step) => step.definitionId === "custom") ? "true" : "false"}\n`
  );
  sequence.steps.forEach((step, si) => {
    const stepPath = `steps/${setupOrdinal(si)}`;
    write(
      `${stepPath}/step.sh`,
      `definition=${shellQuote(step.definitionId)}\nset_count=${step.optionSets.length}\n`
    );
    step.optionSets.forEach((set: any, oi) => {
      if (step.definitionId === "custom") {
        const staged = manifest.scripts.find((script) => script.scriptRef === step.scriptRef)!;
        const selected = path.posix.join(
          input.containerInputRoot ?? "/run/parkbench/setup-input",
          path.relative(manifest.paths.input, staged.stagedPath).split(path.sep).join("/")
        );
        const launcher = path.posix.join(
          input.containerHelpersPath ?? "/usr/local/lib/parkbench/setup",
          "run-custom.sh"
        );
        write(
          `${stepPath}/${setupOrdinal(oi)}/command.sh`,
          `${shellQuote(launcher)} ${shellQuote(selected)} ${set.input}`
        );
        return;
      }
      const args = [input.databaseName, "-C", step.definitionId];
      let stdin = "",
        transcript = "none";
      if (step.definitionId === "idxbuild") {
        if (set.scope === "all") {
          args.push("all");
          stdin = "y\ny\n";
        } else if (set.scope === "table") {
          args.push("table", set.table);
          stdin = "y\ny\n";
        } else {
          if (
            set.indexes.some(
              (target: any) => /[\r\n\0]/.test(target.table) || /[\r\n\0]/.test(target.index)
            )
          )
            throw new Error("database_setup_unavailable:selected_index_transcript_target");
          transcript = "openedge-12.8-some.v1";
          stdin =
            "s\n" +
            set.indexes.map((target: any) => `${target.table}\n${target.index}\n`).join("") +
            "!\ny\ny\n";
        }
      } else if (step.definitionId === "idxcompact") {
        args.push(set.index);
        if (set.mode) args.push("unusedblocks");
        else if (set.compactionPercent !== undefined) args.push(String(set.compactionPercent));
      } else {
        args.push(set.table);
        if (set.useIndex) args.push("useindex", set.useIndex);
      }
      args.push("-cpinternal", "UTF-8", ...(set.additionalArguments ?? []));
      // NUL cannot be carried by execve. Preserve structural acceptance and report a runtime-plan error.
      if (args.some((value) => value.includes("\0")))
        throw new Error("database_setup_unavailable:native_argv_transport");
      const setPath = `${stepPath}/${setupOrdinal(oi)}`;
      write(`${setPath}/argv.sh`, "set -- " + args.map(shellQuote).join(" ") + "\n");
      write(`${setPath}/stdin`, stdin);
      write(`${setPath}/transcript-version`, transcript + "\n");
    });
  });
  write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, root };
}
