import { expect, test } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

test("dimension removal preserves values, help identity, and keyboard focus", async ({ page }) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    const add = page.getByRole("button", { name: "Add dimension", exact: true });
    await expect(add).toBeEnabled({ timeout: 15_000 });
    await add.click();
    await add.click();
    await page.getByRole("textbox", { name: "Parameter 1 values", exact: true }).fill("500");
    await page.getByRole("textbox", { name: "Parameter 2 values", exact: true }).fill("1000");
    await page.getByRole("textbox", { name: "Parameter 3 values", exact: true }).fill("1500");
    const lastHelp = await page
      .getByRole("combobox", { name: "Parameter 3 name", exact: true })
      .getAttribute("aria-describedby");
    await page
      .locator(".dimension-row")
      .nth(1)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Parameter 2 name", exact: true })
    ).toBeFocused();
    await expect(
      page.getByRole("textbox", { name: "Parameter 2 values", exact: true })
    ).toHaveValue("1500");
    await expect(
      page.getByRole("combobox", { name: "Parameter 2 name", exact: true })
    ).toHaveAttribute("aria-describedby", lastHelp!);
    await page
      .locator(".dimension-row")
      .first()
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Parameter 1 name", exact: true })
    ).toBeFocused();
    await expect(
      page.getByRole("textbox", { name: "Parameter 1 values", exact: true })
    ).toHaveValue("1500");
    await page
      .locator(".dimension-row")
      .first()
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(add).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test("Schedule controls have accessible names and only database dimensions", async ({ page }) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await expect(page.getByRole("spinbutton", { name: "Repetitions" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Parameter 1 name" })).toBeVisible();
    await expect(
      page.getByText("Database memory cache size in blocks", { exact: true }).first()
    ).toBeVisible();
    await expect(page.getByText(/Database image|PAS image|Credential reference/)).toHaveCount(0);
    const options = await page
      .getByRole("combobox", { name: "Parameter 1 name" })
      .locator("option")
      .allTextContents();
    expect(options.some((value) => value.includes("database.cpuLimit") || value === "-s")).toBe(
      false
    );
  } finally {
    await fixture.close();
  }
});

test("parameter purpose appears directly under fixed and matrix selectors and follows the selected choice", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    for (const width of [1440, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#experiments");
      await page.reload();
      const matrix = page.getByRole("combobox", { name: "Parameter 1 name", exact: true });
      const purpose = async (selector: any, text: string) => {
        await expect(selector).toHaveAttribute("aria-describedby", /.+/);
        const summary = page.locator(`[id="${await selector.getAttribute("aria-describedby")}"]`);
        await expect(summary).toHaveText(text);
        const inputBox = await selector.boundingBox(),
          summaryBox = await summary.boundingBox();
        expect(summaryBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
        expect(summaryBox!.y - inputBox!.y - inputBox!.height).toBeLessThan(32);
      };
      await matrix.selectOption("-B");
      await purpose(matrix, "Database memory cache size in blocks");
      await matrix.selectOption("-diagPrefix");
      await purpose(matrix, "Printable ASCII filename prefix for diagnostic files.");
      await matrix.selectOption("database.biClusterSizeMiB");
      await purpose(matrix, "Size of each before-image recovery-log cluster in MiB");
      await expect(page.locator(".parameter-help")).toHaveCount(0);
      await page.getByText("Database startup parameters (161)", { exact: true }).click();
      const fixed = page.getByRole("combobox", { name: "Startup parameter", exact: true });
      await fixed.selectOption("-B");
      await purpose(fixed, "Database memory cache size in blocks");
      await fixed.selectOption("-ipver");
      await purpose(fixed, "IP protocol version used by database network connections.");
      await expect(page.locator(".parameter-help")).toHaveCount(0);
    }
  } finally {
    await fixture.close();
  }
});

test("help triggers stay circular and keyboard reachable at desktop and narrow widths", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    for (const width of [1440, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#experiments");
      const help = page.getByRole("button", { name: "Help for Parameter 1 name" });
      await expect(help).toBeVisible();
      const shape = await help.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          radius: getComputedStyle(node).borderRadius
        };
      });
      expect(shape.width).toBeGreaterThanOrEqual(20);
      expect(Math.abs(shape.width - shape.height)).toBeLessThanOrEqual(1);
      expect(shape.radius).toBe("50%");
      await help.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("tooltip")).toBeVisible();
    }
  } finally {
    await fixture.close();
  }
});

test("parameter tooltips explain the selected setting and its bounds without internal contract details", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/#experiments");
    const matrix = page.getByRole("combobox", { name: "Parameter 1 name", exact: true });
    const trigger = page.getByRole("button", { name: "Help for Parameter 1 name", exact: true });
    await matrix.selectOption("-B");
    await trigger.focus();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("Keeps database blocks in a shared memory cache");
    await expect(tip).toContainText("10 blocks");
    await expect(tip).toContainText("1,000,000,000 blocks");
    await expect(tip).toContainText("3,000 blocks");
    await expect(tip).toContainText("Multi-user default");
    await expect(tip).not.toContainText(
      /Type \/ form|value token|Process scope|Ownership|Verification|Target \/ documentation|seed-inherited|canonical database parameter name/i
    );
    await expect(
      tip.getByRole("link", { name: "OpenEdge reference", exact: true })
    ).toHaveAttribute("href", /Blocks-in-Database-Buffers-B/);
    const box = await tip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    await page.setViewportSize({ width: 360, height: 400 });
    await expect
      .poll(async () => {
        const bounds = await tip.boundingBox();
        return (
          bounds &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= 360 &&
          bounds.y >= 0 &&
          bounds.y + bounds.height <= 400
        );
      })
      .toBe(true);
    await page.setViewportSize({ width: 480, height: 900 });
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await matrix.selectOption("-bibufs");
    await trigger.hover();
    await expect(tip).toContainText("before-image recovery notes");
    await expect(tip).toContainText("Not specified in documentation");
    await expect(tip).toContainText("64 buffers");
    await page.keyboard.press("Escape");
    await matrix.selectOption("-ipver");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tip).toContainText("IPv4 or IPv6");
    await expect(tip).toContainText("Not applicable");
    await page.keyboard.press("Escape");
    await matrix.selectOption("database.apwCount");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tip).toContainText("write changed database blocks");
    await expect(tip).toContainText("9 writers");
    await matrix.selectOption("database.biwEnabled");
    await expect(tip).toContainText("writes buffered recovery notes");
    await expect(tip).toContainText("Not applicable");
    await expect(tip).toContainText("Disabled");
    await matrix.selectOption("-B");
    await expect(tip).toContainText("Keeps database blocks in a shared memory cache");
    await expect(tip).not.toContainText("9 writers");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Help for BI cluster size (MiB)", exact: true }).focus();
    await expect(tip).toContainText("organized into clusters");
    await expect(tip).toContainText("0.5 MiB");
    await page.setViewportSize({ width: 360, height: 400 });
    await expect
      .poll(async () => {
        const bounds = await tip.boundingBox();
        return (
          bounds &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= 360 &&
          bounds.y >= 0 &&
          bounds.y + bounds.height <= 400
        );
      })
      .toBe(true);
  } finally {
    await fixture.close();
  }
});

test("navigation omits retired tabs and old directory links redirect", async ({ page }) => {
  await page.goto("/#");
  const nav = page.getByRole("navigation");
  for (const name of ["Bootstrap", "Scenarios", "Dashboards"])
    await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
  await page.goto("/#scenarios");
  await expect(page).toHaveURL(/#catalog$/);
  await page.goto("/#dashboards");
  await expect(page).toHaveURL(/#history$/);
  await page.goto("/#dashboards/saved-link");
  await expect(page).toHaveURL(/#dashboards\/saved-link$/);
});

test("unknown destinations offer a route back to Overview", async ({ page }) => {
  await page.goto("/#unknown/missing");
  await expect(page.getByRole("heading", { name: /destination unavailable/i })).toBeVisible();
  await page.getByRole("button", { name: "Open Overview" }).click();
  await expect(page).toHaveURL(/\/#$/);
});
