import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

export const layoutWidths = [375, 768, 1280, 1440];

export async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

export async function aligned(controls: Locator[]) {
  await expect
    .poll(async () => {
      const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
      if (boxes.some((value) => !value)) return Infinity;
      const centers = boxes.map((value) => value!.y + value!.height / 2);
      return Math.max(...centers) - Math.min(...centers);
    })
    .toBeLessThanOrEqual(1);
}

export async function noPageOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
}

export async function evidence(page: Page, testInfo: TestInfo, name: string) {
  const directory = path.resolve(".parkbench/validation/feature021/ui-layout", name);
  await fs.mkdir(directory, { recursive: true });
  const filename = `${testInfo.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 120)}.png`;
  await page.screenshot({ path: path.join(directory, filename), fullPage: true });
}

export async function frameGeometry(frame: Locator) {
  return frame.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const clipping: string[] = [];
    for (
      let parent = element.parentElement;
      parent && parent !== document.body;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (
        ["hidden", "clip", "scroll", "auto"].includes(style.overflowY) &&
        (bounds.top > rect.top + 1 || bounds.bottom < rect.bottom - 1)
      ) {
        clipping.push(parent.className);
      }
    }
    return {
      height: rect.height,
      minimum: parseFloat(getComputedStyle(element).minHeight),
      clipping
    };
  });
}
