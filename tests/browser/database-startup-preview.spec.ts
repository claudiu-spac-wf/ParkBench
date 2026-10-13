import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSeedFixture } from "../helpers/seed";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

test("preview and Queue show startup file, queued override, and scenario defaults", async ({
  page
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-browser-startup-"));
  const previousRoot = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
  process.env.PARKBENCH_CONTAINER_PATH_ROOT = root;
  const scenarios = path.join(root, "scenarios");
  const seeds = path.join(root, "seeds");
  fs.mkdirSync(scenarios);
  fs.mkdirSync(seeds);
  createSeedFixture(seeds, "startup-seed", { startupPf: "-B 500\n" });
  const document: any = structuredClone(scenario);
  const scenarioFile = path.join(scenarios, "crud-rest.json");
  fs.writeFileSync(scenarioFile, JSON.stringify(document));
  const fixture = await createControlUiFixture({ discoveryRoots: { scenarios, seeds } });
  try {
    await installControlUiFixture(page, fixture);
    for (const [value, source] of [
      [500, "startup_file"],
      [1000, "queued"],
      [750, "scenario"]
    ] as const) {
      if (source === "scenario") {
        document.parameterDefinitions = [
          {
            id: "param_B",
            canonicalName: "-B",
            type: "integer",
            minimum: 10,
            maximum: 5000,
            defaultValue: 750,
            description: "Database buffers",
            source: "scenario",
            matrixAllowed: true,
            secret: false,
            definitionVersion: "1"
          }
        ];
        fs.writeFileSync(scenarioFile, JSON.stringify(document));
      }
      await page.goto("/#experiments");
      await page.reload();
      await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
      await page.getByRole("combobox").nth(1).selectOption("input:seeds/startup-seed");
      if (source === "queued")
        await page.getByRole("textbox", { name: "Parameter 1 values" }).fill(String(value));
      else await page.getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByRole("textbox", { name: "Run name" }).fill(`startup-${value}`);
      await page.getByRole("button", { name: "Preview matrix" }).click();
      const row = page.locator(".preview-panel tbody tr");
      await expect(row).toContainText(`-B ${value}`);
      await expect(row).toContainText(source);
      await expect(row).toContainText("startup.pf: present");
      await page.getByRole("button", { name: "Confirm and queue" }).click();
      await expect(page.getByText("Experiment queued")).toBeVisible();
      const queued = fixture.platform.controlUi
        .listQueue()
        .find((run) => run.name?.startsWith(`run_startup-${value}-`));
      expect(queued).toBeTruthy();
      const startup = fixture.platform.repositories.getRun(queued!.id)!.environmentSnapshot
        .databaseStartup as any;
      expect(startup.parameters).toContainEqual(
        expect.objectContaining({
          name: "-B",
          displayValue: String(value),
          source
        })
      );
    }
  } finally {
    await fixture.close();
    if (previousRoot === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
