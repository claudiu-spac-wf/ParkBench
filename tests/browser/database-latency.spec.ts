import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSeedFixture } from "../helpers/seed";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

test("schedules Database Latency as a fixed value and as a matrix dimension", async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-browser-latency-"));
  const previousRoot = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
  process.env.PARKBENCH_CONTAINER_PATH_ROOT = root;
  const scenarios = path.join(root, "scenarios");
  const seeds = path.join(root, "seeds");
  fs.mkdirSync(scenarios);
  fs.mkdirSync(seeds);
  createSeedFixture(seeds, "latency-seed");
  fs.writeFileSync(path.join(scenarios, "crud-rest.json"), JSON.stringify(scenario));
  const fixture = await createControlUiFixture({ discoveryRoots: { scenarios, seeds } });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
    await page.getByRole("combobox").nth(1).selectOption("input:seeds/latency-seed");
    await page.getByRole("textbox", { name: "Run name" }).fill("latency-fixed");
    const latency = page.getByRole("spinbutton", { name: "Database latency (ms)" });

    for (const invalid of ["1001", "-1"]) {
      await latency.fill(invalid);
      await expect(
        page.getByText("Enter a whole number of milliseconds from 0 to 1000.")
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Preview matrix" })).toBeDisabled();
    }
    await latency.fill("150");
    await expect(page.getByText(/High latency multiplies every database round trip/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview matrix" })).toBeEnabled();

    await latency.fill("20");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.locator(".preview-panel tbody tr").first()).toContainText(
      "Latency 20 ms (≈40 ms RTT)"
    );
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    await expect(page.getByText("Experiment queued")).toBeVisible();
    const fixed = fixture.platform.controlUi
      .listQueue()
      .find((run) => run.name?.startsWith("run_latency-fixed-"));
    expect(
      (fixture.platform.repositories.getRun(fixed!.id)!.environmentSnapshot as any)
        .effectiveConfiguration["network.databaseLatencyMs"]
    ).toBe(20);

    await page.goto("/#experiments");
    await page.reload();
    await page.getByRole("combobox").nth(1).selectOption("input:seeds/latency-seed");
    await page.getByRole("textbox", { name: "Run name" }).fill("latency-matrix");
    await page
      .getByRole("combobox", { name: "Parameter 1 name" })
      .selectOption("network.databaseLatencyMs");
    await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("0, 5, 20");
    await expect(latency).toBeDisabled();
    await expect(page.getByText("Set as a matrix dimension below.")).toBeVisible();
    await page.getByRole("button", { name: "Preview matrix" }).click();
    const rows = page.locator(".preview-panel tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText("Latency 5 ms (≈10 ms RTT)");
    await expect(rows.nth(2)).toContainText("Latency 20 ms (≈40 ms RTT)");
  } finally {
    await fixture.close();
    if (previousRoot === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
