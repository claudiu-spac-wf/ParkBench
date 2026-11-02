import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";
test("one custom script retains multiple exact raw option sets including an empty invocation", async ({
  page
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-custom-browser-"));
  fs.writeFileSync(path.join(root, "prepare.sh"), "#!/bin/sh\nexit 0\n");
  const fixture = await createControlUiFixture({ discoveryRoots: { scripts: root } });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await page.getByLabel("Setup operation", { exact: true }).selectOption("custom");
    await page.getByRole("button", { name: "Add setup step", exact: true }).click();
    const step = page.locator(".database-setup-step").first();
    await step.getByLabel("Script file", { exact: true }).selectOption("input:scripts/prepare.sh");
    await step.getByRole("button", { name: "Add settings", exact: true }).click();
    const raw = '"customer group"\n--mode=fast\n\n';
    await step.getByLabel("Script input", { exact: true }).nth(1).fill(raw);
    await expect(step.getByLabel("Script input", { exact: true }).first()).toHaveValue("");
    await page.getByLabel("Run name", { exact: true }).fill("custom-setup");
    await page.getByRole("button", { name: "Preview matrix", exact: true }).click();
    await expect(page.locator(".preview-panel")).toContainText("prepare.sh");
    const calls = fixture.platform.controlUi.listQueue();
    expect(calls).toHaveLength(0);
    await page.getByRole("button", { name: "Confirm and queue", exact: true }).click();
    await expect(page.getByText("Experiment queued", { exact: true })).toBeVisible();
    const queued = fixture.platform.controlUi.listQueue();
    expect(queued.length).toBe(4);
    for (const run of queued) {
      const config = fixture.platform.repositories.getRun(run.id)!.environmentSnapshot
        .databaseSetup as any;
      expect(config.steps[0].optionSets.map((x: any) => x.input)).toEqual(["", raw]);
    }
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import scenario from "../../examples/scenarios/crud-rest.json";
import { pendingSetupEvidence } from "../../packages/contracts/src/database-setup";
test("live and historical setup show waiting processes and separate primary/shell outcomes", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    const setup: any = {
      contractVersion: "database-setup.v1",
      steps: [
        {
          id: "custom",
          definitionId: "custom",
          scriptRef: "input:scripts/prepare.sh",
          optionSets: [
            { id: "first", input: "detach" },
            { id: "later", input: "" }
          ]
        }
      ]
    };
    const seeded = await seedTerminalMatrix(fixture);
    const run = fixture.platform.repositories.getRun(seeded.runIds[0])!;
    run.environmentSnapshot = { ...run.environmentSnapshot, databaseSetup: setup };
    const evidence = pendingSetupEvidence(run.id, "attempt-1", setup);
    evidence.state = "RUNNING";
    evidence.phase = "waiting-processes";
    evidence.startedAt = new Date().toISOString();
    evidence.activeStepId = "custom";
    evidence.activeOptionSetId = "first";
    evidence.steps[0].state = "RUNNING";
    Object.assign(evidence.steps[0].optionSets[0], {
      state: "RUNNING",
      startedAt: evidence.startedAt,
      primaryInvocationObserved: true,
      primaryExitStatus: 0,
      shellExitStatus: 0,
      processScopeState: "ACTIVE",
      quiescentAt: null
    });
    run.state = "PROVISIONING";
    run.startedAt = evidence.startedAt;
    run.environmentSnapshot = { ...run.environmentSnapshot, databaseSetupEvidence: evidence };
    fixture.platform.repositories.saveRun(run);
    await installControlUiFixture(page, fixture);
    await page.goto(`/#runs/${run.id}`);
    const status = page.getByRole("region", { name: "Database setup status", exact: true });
    await expect(status).toContainText("Waiting for background processes");
    await expect(status).toContainText("Selected script");
    await expect(status).toContainText("Surrounding shell");
    await expect(status).toContainText("ACTIVE");
    await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeEnabled();
    evidence.state = "FAILED";
    evidence.finishedAt = new Date().toISOString();
    evidence.failure = { code: "database_setup_failed", message: "Selected script failed" };
    evidence.steps[0].state = "FAILED";
    Object.assign(evidence.steps[0].optionSets[0], {
      state: "FAILED",
      exitStatus: 7,
      primaryExitStatus: 7,
      processScopeState: "QUIESCENT",
      quiescentAt: evidence.finishedAt,
      finishedAt: evidence.finishedAt
    });
    evidence.steps[0].optionSets[1].state = "NOT_EXECUTED";
    run.state = "FAILED";
    run.cleanupStatus = "COMPLETE";
    run.finishedAt = evidence.finishedAt;
    run.environmentSnapshot = { ...run.environmentSnapshot, databaseSetupEvidence: evidence };
    fixture.platform.repositories.saveRun(run);
    await page.goto("/#history");
    await page.getByRole("button", { name: `Inspect ${run.id}`, exact: true }).click();
    const history = page.getByRole("region", { name: "Database setup status", exact: true });
    await expect(history).toContainText("Exit 7");
    await expect(history).toContainText("QUIESCENT");
    await expect(history).toContainText("NOT_EXECUTED");
  } finally {
    await fixture.close();
  }
});
