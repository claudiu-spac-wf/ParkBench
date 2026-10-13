#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot, readProfile, validateCalibration } from "./read-calibration.mjs";

export const mixes = [
  { name: "90-10", readShare: 0.9, readMultiplier: 450, writeMultiplier: 37 },
  { name: "80-20", readShare: 0.8, readMultiplier: 200, writeMultiplier: 37 },
  { name: "70-30", readShare: 0.7, readMultiplier: 350, writeMultiplier: 111 }
];
export function readOperations(report, profile) {
  validateCalibration(report, { profile });
  return profile.operations.map((original) => {
    const op = structuredClone(original);
    op.bodyTemplate.input.WhereClause = op.bodyTemplate.input.WhereClause.replaceAll(
      "{{cutoff}}",
      String(report.cutoffN)
    );
    op.bodyTemplate.input.Limit = 0;
    op.templateValues.band = { kind: "uniformInt", min: 1, max: report.cutoffN };
    const partition = profile.partitionMap?.find((p) => p.operationId === op.id);
    if (partition) {
      const key = partition.keyFields[0];
      op.templateValues.partition = { kind: "uniformInt", min: 1, max: partition.ranges.length };
      const predicates = partition.ranges.map((range, i) => {
        const bounds = [`{{partition}} = ${i + 1}`];
        if (range.lowerInclusive !== null) bounds.push(`${key} >= ${range.lowerInclusive[0]}`);
        if (range.upperExclusive !== null) bounds.push(`${key} < ${range.upperExclusive[0]}`);
        return `(${bounds.join(" AND ")})`;
      });
      op.bodyTemplate.input.WhereClause += ` AND (${predicates.join(" OR ")})`;
    }
    return op;
  });
}
export function buildScenarios(
  report,
  profile = readProfile(),
  writes = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "examples/scenarios/parkbench-banking-writes.json"),
      "utf8"
    )
  )
) {
  const reads = readOperations(report, profile);
  const writeOperations = writes.workload.operations;
  if (
    writeOperations.length !== 17 ||
    writeOperations.reduce((s, o) => s + o.weight, 0) !== 100 ||
    new Set([...reads, ...writeOperations].map((o) => o.id)).size !== 33
  )
    throw new Error("benchmark_write_profile_invalid");
  const base = {
    schemaVersion: "scenario.v2",
    version: "1.0.0",
    target: structuredClone(profile.common.target),
    phases: { warmupSeconds: 30, measurementSeconds: 120, cooldownSeconds: 10 },
    observers: structuredClone(profile.common.observers)
  };
  const scenarios = [
    {
      ...base,
      id: "parkbench-read-mix",
      name: "ParkBench reads",
      description: "Complete sampled read buckets within the calibrated eligible data footprint.",
      workload: { operations: reads, load: structuredClone(profile.common.load) }
    }
  ];
  for (const mix of mixes)
    scenarios.push({
      ...structuredClone(base),
      id: `parkbench-read-write-${mix.name}`,
      name: `ParkBench reads + writes ${mix.name.replace("-", "/")}`,
      description: `${mix.name.replace("-", "/")} read/write selection probabilities with calibrated complete read buckets and unchanged banking writes.`,
      workload: {
        operations: [
          ...reads.map((o) => ({ ...structuredClone(o), weight: o.weight * mix.readMultiplier })),
          ...writeOperations.map((o) => ({
            ...structuredClone(o),
            weight: o.weight * mix.writeMultiplier
          }))
        ],
        load: structuredClone(profile.common.load)
      }
    });
  return scenarios;
}
export function generate(options = {}) {
  const report = JSON.parse(
    fs.readFileSync(
      options.calibration ??
        path.join(repositoryRoot, "examples/calibrations/parkbench-read-calibration.json"),
      "utf8"
    )
  );
  const scenarios = buildScenarios(report);
  const directory = options.directory ?? path.join(repositoryRoot, "examples/scenarios");
  const rendered = scenarios.map((scenario) => ({
    filename: path.join(directory, scenario.id + ".json"),
    content: JSON.stringify(scenario, null, 2) + "\n"
  }));
  if (options.check) {
    for (const file of rendered)
      if (!fs.existsSync(file.filename) || fs.readFileSync(file.filename, "utf8") !== file.content)
        throw new Error("benchmark_scenario_drift:" + path.basename(file.filename));
  } else {
    fs.mkdirSync(directory, { recursive: true });
    for (const file of rendered) fs.writeFileSync(file.filename, file.content);
  }
  return {
    state: options.check ? "checked" : "generated",
    scenarios: scenarios.map((s) => s.id),
    cutoffN: report.cutoffN,
    referenceSeed: "reference seed not reverified"
  };
}
function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") options.check = true;
    else if (argv[i] === "--calibration" && argv[i + 1] && !argv[i + 1].startsWith("--"))
      options.calibration = argv[++i];
    else throw new Error("benchmark_generator_arguments_invalid");
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(generate(args(process.argv.slice(2)))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
