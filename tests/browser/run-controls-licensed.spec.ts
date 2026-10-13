import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../../packages/contracts/src/config";
import { loadOpenEdgeImageEnvironment } from "../../packages/contracts/src/local-env";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { installControlUiFixture } from "./support/control-ui-fixture";

test("licensed UI sweep matches frozen BI controls before native measurement", async ({ page }) => {
  test.skip(
    process.env.PARKBENCH_RUN_OPENEDGE_TESTS !== "1",
    "requires licensed native inputs and configured metrics services"
  );
  test.setTimeout(600_000);
  page.setDefaultTimeout(15_000);
  const root = path.resolve(".parkbench/validation/feature021/p1/native-ui");
  fs.mkdirSync(path.join(root, "scenarios"), { recursive: true });
  const scenario = JSON.parse(
    fs.readFileSync(".parkbench/validation/feature021/p1/contention-free-scenario.json", "utf8")
  );
  fs.writeFileSync(path.join(root, "scenarios", "native-controls.json"), JSON.stringify(scenario));
  const preliminary = loadConfig();
  loadOpenEdgeImageEnvironment(process.cwd(), preliminary.openedge.outputRoot!);
  const configured = loadConfig();
  let metricsTarget = "";
  const platform = createPlatform(
    {
      ...configured,
      dbPath: ":memory:",
      artifactRoot: path.join(root, "artifacts"),
      runRoot: path.join(root, "compose"),
      discoveryRoots: {
        ...configured.discoveryRoots!,
        scenarios: path.join(root, "scenarios"),
        archives: path.dirname(configured.openedge.appArchive!)
      }
    },
    {
      targetDiscoveryFileName: `feature021-ui-${process.pid}.json`,
      runCAdvisorTarget: () => metricsTarget
    }
  );
  const app = buildServer(platform);
  const runIds: string[] = [];
  let executionFinished = false;
  const unsubscribe = platform.coordinator.onExperimentFinished(() => {
    executionFinished = true;
  });
  const terminal = new Set([
    "SUCCEEDED",
    "FAILED",
    "INCOMPLETE",
    "CANCELLED",
    "INTERRUPTED",
    "THRESHOLD_FAILED"
  ]);
  try {
    await platform.startupRecovery;
    const address = await app.listen({ host: "0.0.0.0", port: 0 });
    const addresses = Object.values(
      os.networkInterfaces() as Record<
        string,
        Array<{ family: string; internal: boolean; address: string }>
      >
    )
      .flat()
      .filter((a) => a?.family === "IPv4" && !a.internal)
      .map((a) => a!.address);
    metricsTarget = `${process.env.PARKBENCH_SMOKE_METRICS_HOST ?? (addresses.length === 1 ? addresses[0] : "host.docker.internal")}:${new URL(address).port}`;
    await installControlUiFixture(page, {
      platform,
      app,
      async close() {
        await app.close();
      }
    });
    await page.goto("/#experiments");
    const scenarioSelect = page.getByRole("combobox").nth(0);
    await expect
      .poll(() =>
        scenarioSelect
          .locator("option")
          .evaluateAll((options) =>
            options.some(
              (o) => !(o as HTMLOptionElement).disabled && (o as HTMLOptionElement).value
            )
          )
      )
      .toBe(true);
    const scenarioValue = await scenarioSelect
      .locator("option")
      .evaluateAll((options) =>
        options
          .find((o) => !(o as HTMLOptionElement).disabled && (o as HTMLOptionElement).value)
          ?.getAttribute("value")
      );
    expect(scenarioValue).toBeTruthy();
    await scenarioSelect.selectOption(scenarioValue!);
    const seeds = page.getByRole("combobox").nth(1);
    await expect
      .poll(() =>
        seeds
          .locator("option")
          .evaluateAll((options) =>
            options.some(
              (o) => !(o as HTMLOptionElement).disabled && (o as HTMLOptionElement).value
            )
          )
      )
      .toBe(true);
    const seedValue = await seeds
      .locator("option")
      .evaluateAll(
        (options, preferred) =>
          options
            .find(
              (o) =>
                !(o as HTMLOptionElement).disabled &&
                (o as HTMLOptionElement).value &&
                o.textContent === preferred
            )
            ?.getAttribute("value"),
        configured.openedge.defaultSeed
      );
    expect(seedValue).toBeTruthy();
    await seeds.selectOption(seedValue!);
    const archives = page.getByRole("combobox").nth(2);
    await expect
      .poll(() =>
        archives
          .locator("option")
          .evaluateAll((options) =>
            options.some(
              (o) => !(o as HTMLOptionElement).disabled && (o as HTMLOptionElement).value
            )
          )
      )
      .toBe(true);
    const archiveValue = await archives
      .locator("option")
      .evaluateAll((options) =>
        options
          .find((o) => !(o as HTMLOptionElement).disabled && (o as HTMLOptionElement).value)
          ?.getAttribute("value")
      );
    expect(archiveValue).toBeTruthy();
    await archives.selectOption(archiveValue!);
    await page.getByRole("textbox", { name: "Run name" }).fill("feature021-native-ui");
    await page
      .getByRole("combobox", { name: "Parameter 1 name" })
      .selectOption("database.apwCount");
    await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("0,2");
    await page.getByRole("spinbutton", { name: "BI buffers (-bibufs)" }).fill("64");
    await page.getByRole("spinbutton", { name: "BI cluster size (MiB)" }).fill("0.5");
    await page.getByRole("combobox", { name: "BIW process" }).selectOption("false");
    await page.getByText("Database startup parameters (161)", { exact: true }).click();
    for (const [name, value] of [
      ["-diagPrefix", "literal space"],
      ["-T", "/psc/wrk/parkbench/literal spaces"]
    ] as const) {
      await page
        .getByRole("combobox", { name: "Startup parameter", exact: true })
        .selectOption(name);
      await page.getByLabel("Fixed parameter value", { exact: true }).fill(value);
      await page.getByRole("button", { name: "Add fixed parameter" }).click();
    }
    for (const [name, value] of [
      ["-diagFormat", "JSON"],
      ["-threadedServer", "false"],
      ["-ssj", "false"]
    ] as const) {
      await page
        .getByRole("combobox", { name: "Startup parameter", exact: true })
        .selectOption(name);
      await page.getByLabel("Fixed parameter value", { exact: true }).selectOption(value);
      await page.getByRole("button", { name: "Add fixed parameter" }).click();
    }
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.getByRole("heading", { name: "Preview: 2 cells / 2 runs" })).toBeVisible();
    const submissionResponse = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/v1/experiments/submit"
    );
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    const response = await submissionResponse;
    expect(response.ok(), await response.text()).toBeTruthy();
    const submission = await response.json();
    runIds.push(...submission.runs.map((r: any) => r.id));
    expect(runIds).toHaveLength(2);
    await page.screenshot({ path: path.join(root, "queued.png"), fullPage: true });
    await page.getByRole("link", { name: "Open queue", exact: true }).click();
    await page.getByRole("button", { name: "Start eligible work" }).click();
    for (const id of runIds) {
      await expect
        .poll(() => platform.repositories.getRun(id)?.state, {
          timeout: 240_000,
          intervals: [500, 1000]
        })
        .toBe("WARMING_UP");
      const run = platform.repositories.getRun(id)!;
      const controls: any = run.environmentSnapshot!.databaseRunControls;
      const evidence: any = run.environmentSnapshot!.databaseRunControlEvidence;
      expect(evidence.verification).toBe("matched");
      expect(controls.requirements).toEqual({
        namedLatchRequired: true,
        observerProtocolVersion: 4
      });
      const inventory = (run.environmentSnapshot!.namedLatchInventories as any[])[0];
      expect(inventory.runId).toBe(id);
      expect(inventory.complete).toBe(true);
      expect(inventory.instances.length).toBeGreaterThan(0);
      expect(evidence.observed.apwCount).toBe(controls.apwCount);
      expect(evidence.observed.biwCount).toBe(0);
      expect(evidence.observed.biBuffers).toBe(64);
      expect(evidence.observed.nativeClusterKiB).toBe(512);
      await expect
        .poll(() => platform.repositories.getRun(id)?.state, { timeout: 30_000, intervals: [500] })
        .toBe("MEASURING");
      expect(Date.parse(evidence.capturedAt)).toBeLessThanOrEqual(
        Date.parse(platform.repositories.getRun(id)!.measuringAt!)
      );
      await expect
        .poll(() => terminal.has(platform.repositories.getRun(id)!.state), { timeout: 120_000 })
        .toBe(true);
      await expect
        .poll(() => platform.repositories.getRun(id)?.cleanupStatus, { timeout: 120_000 })
        .toBe("COMPLETE");
      const finished = platform.repositories.getRun(id)!;
      expect(
        finished.state,
        JSON.stringify({
          reason: finished.failureReason,
          gaps: finished.completeness?.requiredGaps
        })
      ).toBe("SUCCEEDED");
      expect(finished.cleanupStatus).toBe("COMPLETE");
      fs.writeFileSync(
        path.join(root, `${id}-acceptance.json`),
        JSON.stringify(
          {
            runId: id,
            state: finished.state,
            cleanup: finished.cleanupStatus,
            controls,
            evidence,
            namedLatchInventory: inventory
          },
          null,
          2
        )
      );
    }
  } finally {
    for (const id of runIds)
      if (!terminal.has(platform.repositories.getRun(id)!.state)) platform.coordinator.cancel(id);
    for (const id of runIds)
      await expect
        .poll(() => platform.repositories.getRun(id)?.cleanupStatus, { timeout: 120_000 })
        .toBe("COMPLETE");
    if (runIds.length) await expect.poll(() => executionFinished, { timeout: 30_000 }).toBe(true);
    unsubscribe();
    await app.close();
  }
});
