import { test, expect } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";
import { resolveDatabaseIops } from "../../packages/contracts/src/database-iops";
import fs from "node:fs";
import path from "node:path";
test("recorded IOPS survives detail projections and legacy absence stays Not recorded", async ({
  page
}) => {
  test.setTimeout(90000);
  const fixture = await createControlUiFixture();
  try {
    const seeded = await seedTerminalMatrix(fixture);
    const ids = seeded.runIds.slice(0, 4);
    for (const [i, id] of ids.entries()) {
      const run = fixture.platform.repositories.getRun(id)!;
      const metadata = fixture.platform.controlRepository.getRunMetadata(id)!;
      const snapshot: any = structuredClone(run.environmentSnapshot);
      if (i === 3) {
        delete snapshot.databaseIops;
        delete snapshot.databaseIopsEvidence;
        delete snapshot.requestedConfiguration.databaseIops;
        delete snapshot.variant.databaseIops;
        delete (metadata.snapshot as any).databaseIops;
        delete (metadata.snapshot as any).databaseIopsEvidence;
      } else {
        const condition = resolveDatabaseIops(i === 1 ? "unlimited" : "hdd");
        snapshot.databaseIops = condition;
        snapshot.requestedConfiguration.databaseIops = condition;
        snapshot.variant.databaseIops = condition;
        const evidence: any = {
          contractVersion: "database-iops-evidence.v1",
          condition,
          stage: i === 2 ? "FAILED" : "COMPLETED",
          mode: "native",
          verification: {
            status: i === 2 ? "UNAVAILABLE" : i === 1 ? "NO_ADDED_CAP" : "MATCHED",
            checks: 3,
            lastVerifiedAt: new Date().toISOString()
          },
          deviceCount: 1
        };
        const artifact = fixture.platform.artifacts.write(
          id,
          "diagnostics",
          "database-iops-evidence.v1.json",
          JSON.stringify(evidence),
          "json",
          { contractVersion: evidence.contractVersion }
        );
        evidence.artifactId = artifact.id;
        snapshot.databaseIopsEvidence = evidence;
        (metadata.snapshot as any).databaseIops = condition;
        (metadata.snapshot as any).databaseIopsEvidence = evidence;
        if (i === 2) {
          run.state = "FAILED";
          run.measurementValidity = "UNAVAILABLE";
        }
      }
      run.environmentSnapshot = snapshot;
      fixture.platform.repositories.saveRun(run);
      fixture.platform.controlRepository.saveRunMetadata({ ...metadata, runId: id });
    }
    await installControlUiFixture(page, fixture);
    await page.goto("/#history");
    for (const [i, id] of ids.entries()) {
      await page.getByRole("button", { name: `Inspect ${id}`, exact: true }).click();
      const detail = page.locator("aside .database-iops-summary");
      await expect(detail).toContainText(
        i === 3 ? "Not recorded" : i === 1 ? "no added cap" : "150 read / 150 write"
      );
      if (i === 0)
        await expect(detail.getByRole("link", { name: "IOPS diagnostics" })).toBeVisible();
    }
    await page.goto(`/#runs/${ids[0]}`);
    await expect(page.locator(".database-iops-summary")).toContainText("150 read / 150 write");
    await page.goto(`/#comparison/${seeded.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await page.locator(`details.comparison-run[data-run-id="${ids[0]}"] > summary`).click();
    await page.locator(`details.comparison-run[data-run-id="${ids[3]}"] > summary`).click();
    await expect(
      page.locator(".database-iops-summary").filter({ hasText: "HDD" }).first()
    ).toContainText("150 read / 150 write");
    await expect(
      page.locator(".database-iops-summary").filter({ hasText: "Not recorded" }).first()
    ).toBeVisible();
    const out = path.resolve(".parkbench/validation/feature025/ui");
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({
      path: path.join(out, "comparison-recorded-legacy.png"),
      fullPage: true
    });
  } finally {
    await fixture.close();
  }
});
