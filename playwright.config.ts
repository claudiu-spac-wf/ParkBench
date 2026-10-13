/**
 * Browser-test contract consumed by the optional Playwright runner in CI.
 * The repository keeps browser dependencies optional for the fake-service and
 * contract suites; the same base URL can be supplied to Playwright when it is
 * installed by an operator.
 */
export default {
  testDir: "./tests/browser",
  testIgnore: "**/licensed-parkbench.spec.ts",
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env.CI ? "line" : "list",
  use: { baseURL: process.env.PARKBENCH_CONTROL_UI_URL ?? "http://127.0.0.1:4173" },
  webServer: {
    command: "npm run dev --workspace @parkbench/web -- --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: true
  }
};
