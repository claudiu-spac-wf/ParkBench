import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/licensed-parkbench.spec.ts",
  timeout: 1_800_000,
  fullyParallel: false,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: process.env.PARKBENCH_LICENSED_UI_URL ?? "http://127.0.0.1:13002/",
    trace: "retain-on-failure"
  }
});
