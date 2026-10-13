import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createSeedFixture } from "../helpers/seed";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

test("schedules exact fixed BI controls with visible help and retained zero/false", async ({
  page
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-browser-controls-"));
  const previous = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
  process.env.PARKBENCH_CONTAINER_PATH_ROOT = root;
  const scenarios = path.join(root, "scenarios"),
    seeds = path.join(root, "seeds");
  fs.mkdirSync(scenarios);
  fs.mkdirSync(seeds);
  createSeedFixture(seeds, "controls-seed");
  fs.writeFileSync(
    path.join(scenarios, "crud-rest.json"),
    JSON.stringify({
      ...scenario,
      parameterDefinitions: [
        {
          id: "only-B",
          canonicalName: "-B",
          type: "integer",
          minimum: 10,
          maximum: 5000,
          description: "Primary buffers",
          source: "scenario",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        }
      ]
    })
  );
  const fixture = await createControlUiFixture({
    discoveryRoots: { scenarios, seeds },
    databaseCapabilities: { version: "12.8.11", features: ["enterprise"] }
  });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await page.getByRole("combobox").nth(1).selectOption("input:seeds/controls-seed");
    await page.getByRole("textbox", { name: "Run name" }).fill("bi-controls");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("spinbutton", { name: "BI buffers (-bibufs)" }).fill("64");
    await page.getByRole("spinbutton", { name: "APW count" }).fill("0");
    await page.getByRole("spinbutton", { name: "BI cluster size (MiB)" }).fill("0.5");
    await page.getByRole("combobox", { name: "BIW process" }).selectOption("false");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.locator(".preview-panel")).toContainText("0.5 MiB");
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    await expect(page.getByText("Experiment queued")).toBeVisible();
    const c = fixture.platform.controlUi.listQueue()[0].snapshot.databaseRunControls as any;
    expect(c.apwCount).toBe(0);
    expect(c.biwEnabled).toBe(false);
    expect(c.biCluster.nativeKiB).toBe(512);
  } finally {
    await fixture.close();
    if (previous === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validates fixed inputs, pending inheritance, and exact typed sweeps", async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-browser-controls-"));
  const previous = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
  process.env.PARKBENCH_CONTAINER_PATH_ROOT = root;
  const scenarios = path.join(root, "scenarios"),
    seeds = path.join(root, "seeds");
  fs.mkdirSync(scenarios);
  fs.mkdirSync(seeds);
  createSeedFixture(seeds, "controls-seed");
  fs.writeFileSync(
    path.join(scenarios, "crud-rest.json"),
    JSON.stringify({
      ...scenario,
      parameterDefinitions: [
        {
          id: "only-B",
          canonicalName: "-B",
          type: "integer",
          minimum: 10,
          maximum: 5000,
          description: "Primary buffers",
          source: "scenario",
          matrixAllowed: true,
          secret: false,
          definitionVersion: "1"
        }
      ]
    })
  );
  const fixture = await createControlUiFixture({
    discoveryRoots: { scenarios, seeds },
    databaseCapabilities: { version: "12.8.11", features: ["enterprise"] }
  });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await page.getByRole("combobox").nth(1).selectOption("input:seeds/controls-seed");
    await page.getByRole("textbox", { name: "Run name" }).fill("bi-controls");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("button", { name: "Help for BI buffers (-bibufs)", exact: true }).click();
    await expect(page.getByRole("tooltip")).toContainText("Not specified in documentation");
    await page.getByRole("spinbutton", { name: "APW count" }).fill("10");
    await expect(page.getByRole("button", { name: "Preview matrix" })).toBeDisabled();
    await page.getByRole("spinbutton", { name: "APW count" }).fill("0");
    await page.getByRole("spinbutton", { name: "BI cluster size (MiB)" }).fill("0.1");
    await expect(page.getByRole("button", { name: "Preview matrix" })).toBeDisabled();
    await page.getByRole("spinbutton", { name: "BI cluster size (MiB)" }).fill("");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.locator(".preview-panel")).toContainText(
      "Inherited — pending native observation"
    );
    await page.getByRole("button", { name: "Add dimension" }).click();
    await page
      .getByRole("combobox", { name: "Parameter 1 name", exact: true })
      .selectOption("database.apwCount");
    await page.getByRole("textbox", { name: "Parameter 1 values", exact: true }).fill("0, 2");
    await page.getByRole("button", { name: "Add dimension" }).click();
    await page
      .getByRole("combobox", { name: "Parameter 2 name", exact: true })
      .selectOption("database.biwEnabled");
    await page
      .getByRole("textbox", { name: "Parameter 2 values", exact: true })
      .fill("false, true");
    await page.getByRole("button", { name: "Add dimension" }).click();
    await page
      .getByRole("combobox", { name: "Parameter 3 name", exact: true })
      .selectOption("database.biClusterSizeMiB");
    await page
      .getByRole("textbox", { name: "Parameter 3 values", exact: true })
      .fill("0.015625, 0.5");
    await page.getByRole("button", { name: "Add dimension" }).click();
    await page
      .getByRole("combobox", { name: "Parameter 4 name", exact: true })
      .selectOption("-bibufs");
    await page.getByRole("textbox", { name: "Parameter 4 values", exact: true }).fill("64, 128");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.getByRole("heading", { name: "Preview: 16 cells / 16 runs" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    await expect(page.getByText("Experiment queued")).toBeVisible();
    const queued = fixture.platform.controlUi.listQueue();
    expect(queued).toHaveLength(16);
    for (const run of queued) {
      const c = run.snapshot.databaseRunControls as any;
      expect([0, 2]).toContain(c.apwCount);
      expect([false, true]).toContain(c.biwEnabled);
      expect([16, 512]).toContain(c.biCluster.nativeKiB);
    }
  } finally {
    await fixture.close();
    if (previous === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
