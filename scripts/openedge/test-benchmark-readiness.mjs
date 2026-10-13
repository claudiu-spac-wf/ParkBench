#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calibrate, ReadFixture } from "./calibrate-read-footprint.mjs";
import {
  repositoryRoot,
  readProfile,
  validateCalibration,
  fingerprintSeed
} from "./read-calibration.mjs";
import { buildScenarios } from "./generate-benchmark-scenarios.mjs";

export async function run(options) {
  if (
    !options.seed ||
    !options.config ||
    !options.calibration ||
    !options.report ||
    !["bounded-reads", "scenarios"].includes(options.suite)
  )
    throw new Error("benchmark_acceptance_arguments_required");
  if (options.scenario && options.suite !== "scenarios")
    throw new Error("benchmark_scenario_suite_required");
  const profile = readProfile(),
    accepted = validateCalibration(JSON.parse(fs.readFileSync(options.calibration, "utf8")), {
      profile
    });
  const evidence = {
    suite: options.suite,
    startedAt: new Date().toISOString(),
    ok: false,
    cases: []
  };
  let fixture;
  try {
    const identity = await calibrate({
      seed: options.seed,
      config: options.config,
      calibration: options.calibration,
      verifyOnly: true
    });
    evidence.reference = identity.evidence;
    if (evidence.reference.state !== "verified") throw new Error("benchmark_reference_unverified");
    if (options.suite === "scenarios") {
      const { runScenarios } = await import("./benchmark-scenario-acceptance.mjs");
      evidence.scenarios = await runScenarios(options, accepted);
    } else {
      fixture = new ReadFixture({ seed: options.seed });
      await fixture.start();
      evidence.imageId = fixture.imageId;
      evidence.evidenceRoot = path.relative(repositoryRoot, fixture.root);
      fs.cpSync(
        path.join(repositoryRoot, "openedge/workloads/Workloads/Generic"),
        path.join(fixture.root, "Workloads/Generic"),
        { recursive: true, filter: (file) => !file.endsWith(".r") }
      );
      fixture.compileSources(["/validation/Workloads/Generic/arbitrary_reads.p"]);
      fixture.compile();
      evidence.pas = await fixture.startPas();
      const scenario = buildScenarios(accepted, profile)[0];
      for (const op of scenario.workload.operations) {
        const table = accepted.tables.find((t) => t.name === op.bodyTemplate.input.TableName);
        const admitted = table.buckets.filter((b) => b.bucket <= accepted.cutoffN);
        const candidates = new Set([
          admitted.reduce((a, b) => (a.totalBytes >= b.totalBytes ? a : b)).bucket,
          admitted.reduce((a, b) => (a.rowCount >= b.rowCount ? a : b)).bucket
        ]);
        const emptyBucket = admitted.find((b) => b.rowCount === 0);
        if (emptyBucket) candidates.add(emptyBucket.bucket);
        for (const band of candidates) {
          const began = Date.now();
          const response = await fixture.requestProcedure(
            op.bodyTemplate.procName,
            {
              ...op.bodyTemplate.input,
              WhereClause: op.bodyTemplate.input.WhereClause.replaceAll("{{band}}", String(band))
            },
            { timeoutMs: 60000 }
          );
          if (response.status !== 200 || Date.now() - began >= 60000)
            throw new Error(
              "benchmark_read_deadline_or_failure:" + op.id + ":" + JSON.stringify(response)
            );
          evidence.cases.push({
            operationId: op.id,
            band,
            expectedRows: table.buckets[band - 1].rowCount,
            expectedBytes: table.buckets[band - 1].totalBytes,
            elapsedMs: Date.now() - began,
            ...response
          });
        }
      }
      fixture.stopPas();
      evidence.byteAccounting = fixture.byteFixtures();
      fs.copyFileSync(
        path.join(repositoryRoot, "openedge/validation/invalid-read-bucket.p"),
        path.join(fixture.root, "invalid-read-bucket.p")
      );
      fixture.compileSources(["/validation/invalid-read-bucket.p"]);
      fixture.invoke(
        "/validation/invalid-read-bucket.r",
        { bucket: accepted.cutoffN + 1, report: "/validation/excluded-bucket-prepare.json" },
        "excluded-bucket-prepare.json"
      );
      const driver = "bounded-read-fixtures";
      fs.copyFileSync(
        path.join(repositoryRoot, "openedge/validation", driver + ".p"),
        path.join(fixture.root, driver + ".p")
      );
      fixture.compileSources(["/validation/" + driver + ".p"]);
      evidence.reachability = fixture.invoke(
        "/validation/" + driver + ".r",
        {
          operations: scenario.workload.operations,
          cutoff: accepted.cutoffN,
          report: "/validation/bounded-fixtures.json"
        },
        "bounded-fixtures.json"
      );
      if (
        !evidence.reachability.ok ||
        evidence.reachability.cases.length !== 16 ||
        !evidence.reachability.cases.some(
          (c) =>
            c.operationId === "debit-history-amounts" &&
            c.largestRows >= 2501 &&
            c.actualWorkloadReads >= 2501
        ) ||
        !evidence.reachability.cases.some((c) => c.emptyBuckets > 0)
      )
        throw new Error("benchmark_read_reachability_failed");
      // RandomInt1000 is mandatory in the real schema. The unknown-value
      // rejection case needs a deliberately different disposable schema; it is
      // never attributed to the reference calibration or reachability proof.
      fixture.prepareEmpty({
        count: 400,
        schemaTransform: (definition) => {
          const pattern = /(ADD FIELD "RandomInt1000" OF "Account"[\s\S]*?)(?=\nADD FIELD)/;
          const match = pattern.exec(definition);
          if (!match || !match[1].includes("  MANDATORY"))
            throw new Error("invalid_bucket_fixture_schema_not_found");
          return definition.replace(pattern, match[1].replace(/^  MANDATORY\s*$/m, ""));
        }
      });
      fixture.compileReadProbes();
      fs.copyFileSync(
        path.join(repositoryRoot, "openedge/validation/invalid-read-bucket.p"),
        path.join(fixture.root, "invalid-read-bucket.p")
      );
      fixture.compileSources(["/validation/invalid-read-bucket.p"]);
      evidence.invalidBuckets = [];
      for (const bucket of [null, 0, 1001]) {
        fixture.invoke(
          "/validation/invalid-read-bucket.r",
          { bucket, report: "/validation/invalid-bucket-prepare.json" },
          "invalid-bucket-prepare.json"
        );
        const expected = bucket === null ? "read_bucket_unknown" : "read_bucket_out_of_range";
        let error;
        try {
          fixture.probe({}, "invalid-histogram.json");
        } catch (failure) {
          error = failure.message;
        }
        if (
          !error?.includes(expected) ||
          fs.existsSync(path.join(fixture.root, "invalid-histogram.json"))
        )
          throw new Error("benchmark_invalid_bucket_not_rejected:" + bucket);
        evidence.invalidBuckets.push({ bucket, diagnostic: expected, rejected: true });
      }
      fixture.close();
      fixture = undefined;
      evidence.cleanup = true;
    }
    if ((await fingerprintSeed(options.seed)) !== accepted.seed.fingerprint)
      throw new Error("benchmark_source_changed");
    evidence.sourceUnchanged = true;
    evidence.ok = true;
    return evidence;
  } catch (error) {
    evidence.error = error.message;
    throw error;
  } finally {
    if (fixture) {
      try {
        fixture.close();
        evidence.cleanup = true;
      } catch (error) {
        evidence.cleanup = false;
        evidence.cleanupError = error.message;
      }
    }
    evidence.completedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
    fs.writeFileSync(options.report, JSON.stringify(evidence, null, 2) + "\n");
  }
}
function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (
      !["--suite", "--seed", "--config", "--calibration", "--report", "--scenario"].includes(
        argv[i]
      ) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw new Error("benchmark_acceptance_arguments_invalid");
    options[argv[i].slice(2)] = argv[++i];
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = await run(args(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: evidence.ok, suite: evidence.suite }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
