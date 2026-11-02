import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, Page } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

async function populate(page: Page, fixture: Awaited<ReturnType<typeof createControlUiFixture>>) {
  await installControlUiFixture(page, fixture);
  await page.goto("http://127.0.0.1:4173/#experiments");
  for (const operation of ["idxbuild", "idxbuild", "idxcompact", "tablereorg", "custom"]) {
    await page
      .getByRole("combobox", { name: "Setup operation", exact: true })
      .selectOption(operation);
    await page.getByRole("button", { name: "Add setup step", exact: true }).click();
  }
  const steps = page.locator(".database-setup-step");
  await steps.nth(0).getByRole("combobox", { name: "Scope", exact: true }).selectOption("table");
  await steps.nth(1).getByRole("combobox", { name: "Scope", exact: true }).selectOption("indexes");
  await steps.nth(1).getByRole("button", { name: "Add index target", exact: true }).click();
  await steps
    .nth(4)
    .getByRole("combobox", { name: "Script file", exact: true })
    .selectOption("input:scripts/prepare.sh");
}

async function inspect(page: Page, name: string) {
  const result = await page.locator(".database-setup-fields").evaluate((root) => {
    const issues: string[] = [];
    const rect = (element: Element) => element.getBoundingClientRect();
    const compare = (elements: Element[], context: string) => {
      for (let i = 1; i < elements.length; i++) {
        const a = rect(elements[0]),
          b = rect(elements[i]);
        if (Math.abs(a.top - b.top) > 1 || Math.abs(a.height - b.height) > 1)
          issues.push(`${context}: top/height ${a.top}/${a.height} vs ${b.top}/${b.height}`);
      }
    };
    for (const row of Array.from(root.querySelectorAll(".setup-add,.setup-custom-source"))) {
      const select = row.querySelector("select"),
        button = row.querySelector(":scope > button");
      if (select && button && rect(button).left > rect(select).left + rect(select).width - 1)
        compare([select, button], row.className);
      else if (select && button && innerWidth >= 768)
        issues.push(`${row.className}: action should share the control row`);
    }
    for (const grid of Array.from(root.querySelectorAll(".setup-inputs"))) {
      const labels = Array.from(grid.querySelectorAll(":scope > label"));
      const rows = new Map<number, Element[]>();
      for (const label of labels) {
        if (label.classList.contains("setup-check")) continue;
        const control = label.querySelector("input:not([type=checkbox]),select,textarea");
        if (!control) continue;
        const top = Math.round(rect(label).top);
        const group = rows.get(top) ?? [];
        group.push(control);
        rows.set(top, group);
      }
      for (const controls of rows.values()) compare(controls, "settings fields");
      const action = grid.querySelector(":scope > button");
      const controls = labels
        .map((label) => label.querySelector("input:not([type=checkbox]),select"))
        .filter(Boolean) as Element[];
      if (action && controls.length && rect(action).left > rect(controls[0]).left)
        compare([...controls, action], "index target action");
      const checkbox = grid.querySelector(":scope > .setup-check input");
      if (checkbox && controls.length && rect(checkbox).left > rect(controls[0]).left) {
        const a = rect(controls[0]),
          b = rect(checkbox);
        if (Math.abs(a.top + a.height / 2 - b.top - b.height / 2) > 1)
          issues.push("unused-blocks checkbox is outside the input track");
      }
    }
    for (const help of Array.from(root.querySelectorAll(".field-help-trigger"))) {
      if (help.closest("h2")) continue;
      const group = help.closest(".setup-field-label") ?? help.closest("label");
      if (!group) continue;
      const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
      let text: Node | null = null;
      while (walker.nextNode()) {
        if (
          walker.currentNode.textContent?.trim() &&
          !walker.currentNode.parentElement?.closest(".field-help")
        ) {
          text = walker.currentNode;
          break;
        }
      }
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const a = range.getClientRects()[0],
        b = rect(help);
      if (a && Math.abs(a.top + a.height / 2 - b.top - b.height / 2) > 1)
        issues.push(`${help.getAttribute("aria-label")}: help is not beside the first text line`);
    }
    return {
      issues,
      overflow: document.documentElement.scrollWidth - innerWidth,
      width: innerWidth,
      dpr: devicePixelRatio
    };
  });
  const output = path.resolve(
    ".parkbench/validation/feature023/script-alignment",
    process.env.PARKBENCH_ALIGNMENT_EVIDENCE_PHASE ?? "after"
  );
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(result, null, 2));
  await page
    .locator(".database-setup-fields")
    .screenshot({ path: path.join(output, `${name}.png`) });
  return result;
}

test("script selectors, settings, help and actions align at supported widths", async ({ page }) => {
  test.setTimeout(90000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-script-layout-"));
  fs.writeFileSync(path.join(root, "prepare.sh"), "#!/bin/sh\nexit 0\n");
  const fixture = await createControlUiFixture({ discoveryRoots: { scripts: root } });
  try {
    await populate(page, fixture);
    const issues: string[] = [];
    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const result = await inspect(page, String(width));
      issues.push(...result.issues.map((issue) => `${width}: ${issue}`));
      expect.soft(result.overflow).toBeLessThanOrEqual(1);
    }
    const compact = page.locator(".database-setup-step").nth(2);
    const checkbox = compact.getByRole("checkbox", { name: "Unused blocks", exact: true });
    await compact.getByRole("button", { name: "Help for Unused blocks", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(
      compact.getByRole("spinbutton", { name: "Compaction percent", exact: true })
    ).toBeDisabled();
    const nativeArguments = compact.getByRole("textbox", {
      name: "Additional native arguments",
      exact: true
    });
    await nativeArguments.fill('"');
    await expect(compact.getByRole("alert")).toBeVisible();
    const title = compact
      .locator(".setup-field-label > span")
      .filter({ hasText: "Additional native arguments" });
    await title.evaluate((element) => {
      element.textContent =
        "Additional native arguments with a long explanation that wraps onto several lines";
    });
    const wrapped = await inspect(page, "1440-wrapped-label-and-error");
    issues.push(...wrapped.issues);
    expect(issues).toEqual([]);
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("script field alignment survives native 200 percent browser zoom", async () => {
  test.setTimeout(90000);
  const { chromium } = await import("@playwright/test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-script-layout-zoom-"));
  const extension = path.join(root, "extension");
  fs.mkdirSync(extension);
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "ParkBench alignment validation zoom",
      version: "1.0",
      permissions: ["tabs"],
      background: { service_worker: "background.js" }
    })
  );
  fs.writeFileSync(
    path.join(extension, "background.js"),
    "chrome.runtime.onInstalled.addListener(() => {});"
  );
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "prepare.sh"), "#!/bin/sh\nexit 0\n");
  const fixture = await createControlUiFixture({ discoveryRoots: { scripts } });
  const context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: null,
    args: [
      "--window-size=1280,1000",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`
    ]
  });
  try {
    const page = await context.newPage();
    await populate(page, fixture);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:4173/*" });
      await chrome.tabs.setZoom(tabs[0].id, 2);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(768);
    const result = await inspect(page, "native-200-percent");
    expect(result.issues).toEqual([]);
    expect(result.overflow).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
