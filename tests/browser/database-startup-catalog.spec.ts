import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createSeedFixture } from "../helpers/seed";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";
test("complete catalog exposes audited help and schedules literal strings/enums/false alongside P1 controls", async ({
  page
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-catalog-browser-"));
  const previous = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
  process.env.PARKBENCH_CONTAINER_PATH_ROOT = root;
  const scenarios = path.join(root, "scenarios"),
    seeds = path.join(root, "seeds");
  fs.mkdirSync(scenarios);
  fs.mkdirSync(seeds);
  createSeedFixture(seeds, "catalog-seed");
  fs.writeFileSync(path.join(scenarios, "crud-rest.json"), JSON.stringify(scenario));
  const fixture = await createControlUiFixture({
    discoveryRoots: { scenarios, seeds },
    databaseCapabilities: { version: "12.8.11", features: ["enterprise"] }
  });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await page.getByRole("combobox").nth(1).selectOption("input:seeds/catalog-seed");
    await page.getByRole("textbox", { name: "Run name" }).fill("catalog-browser");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByText("Database startup parameters (161)", { exact: true }).click();
    const choose = async (name: string) =>
      page.getByRole("combobox", { name: "Startup parameter", exact: true }).selectOption(name);
    const help = page.getByRole("tooltip").locator(".parameter-help");
    const openHelp = async () =>
      page.getByRole("button", { name: "Help for Startup parameter", exact: true }).click();
    await choose("-bibufs");
    await openHelp();
    await expect(help).toContainText("Multi-user minimum");
    await expect(help).toContainText("Not specified in documentation");
    await expect(help).toContainText("64");
    await expect(help.getByRole("link")).toHaveAttribute("href", /docs.progress.com/);
    await page.keyboard.press("Escape");
    await choose("-Passphrase");
    await expect(page.getByRole("status")).toContainText("interactive");
    await expect(page.getByRole("button", { name: "Add fixed parameter" })).toBeDisabled();
    await choose("-diagFS");
    await openHelp();
    await expect(help).toContainText("Not applicable");
    await page.keyboard.press("Escape");
    await page.getByLabel("Fixed parameter value", { exact: true }).fill(" ");
    await page.getByRole("button", { name: "Add fixed parameter" }).click();
    for (const [name, value] of [
      ["-threadedServer", "false"],
      ["-ssj", "false"],
      ["-ipver", "IPv4"]
    ] as const) {
      await choose(name);
      await page.getByLabel("Fixed parameter value", { exact: true }).selectOption(value);
      await page.getByRole("button", { name: "Add fixed parameter" }).click();
    }
    await choose("-T");
    await page
      .getByLabel("Fixed parameter value", { exact: true })
      .fill("/psc/wrk/parkbench/literal spaces");
    await page.getByRole("button", { name: "Add fixed parameter" }).click();
    await page.getByRole("spinbutton", { name: "BI buffers (-bibufs)" }).fill("64");
    await page.getByRole("spinbutton", { name: "APW count" }).fill("0");
    await page.getByRole("combobox", { name: "BIW process" }).selectOption("false");
    await choose("-bibufs");
    await page.getByLabel("Fixed parameter value", { exact: true }).fill("32");
    await page.getByRole("button", { name: "Add fixed parameter" }).click();
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(
      page.getByText(
        "Conflicting values for -bibufs. Set it in one editor or use the same value.",
        { exact: true }
      )
    ).toBeVisible();
    await page.getByLabel("Fixed parameter value", { exact: true }).fill("64");
    await page.getByRole("button", { name: "Replace fixed parameter" }).click();
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.locator(".preview-panel")).toContainText("/psc/wrk/parkbench/literal spaces");
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    await expect(page.getByText("Experiment queued")).toBeVisible();
    const snapshot: any = fixture.platform.controlUi.listQueue()[0].snapshot;
    expect(snapshot.parameters["-T"]).toBe("/psc/wrk/parkbench/literal spaces");
    expect(snapshot.parameters["-diagFS"]).toBe(" ");
    expect(snapshot.parameters["-ssj"]).toBe(false);
    expect(snapshot.databaseRunControls.apwCount).toBe(0);
    expect(snapshot.databaseRunControls.biwEnabled).toBe(false);
  } finally {
    await fixture.close();
    if (previous === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hash latch factor is selectable with percentage limits and startup-only help", async ({
  page
}) => {
  const fixture = await createControlUiFixture({ databaseCapabilities: { version: "12.8.11" } });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    const dimension = page.getByRole("combobox", { name: "Parameter 1 name", exact: true });
    await dimension.selectOption("-hashLatchFactor");
    const summary = await dimension.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${summary}"]`)).toHaveText(
      "Buffer hash table latch count as a percentage of hash entries"
    );
    await page.getByRole("button", { name: "Help for Parameter 1 name", exact: true }).click();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("5 %");
    await expect(tip).toContainText("100 %");
    await expect(tip).toContainText("10 %");
    await expect(tip).toContainText("at least two latches");
    await expect(tip).toContainText("fixed until restart");
    await expect(tip.getByRole("link", { name: "OpenEdge reference" })).toHaveAttribute(
      "href",
      /Buffer-Hash-Latch-Factor-hashLatchFactor/
    );
    await page.keyboard.press("Escape");
    await page.getByText("Database startup parameters (161)", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "Startup parameter", exact: true })
      .selectOption("-hashLatchFactor");
    const value = page.getByRole("spinbutton", { name: "Fixed parameter value", exact: true });
    await expect(value).toHaveAttribute("min", "5");
    await expect(value).toHaveAttribute("max", "100");
    await expect(value).toHaveAttribute("step", "1");
    expect(fixture.platform.controlUi.listQueue()).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
