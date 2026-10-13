import { Page } from "@playwright/test";
import { CatalogAsset } from "../../../packages/contracts/src/control-ui";
import { createControlUiFixture } from "../../fixtures/control-ui";

export type BrowserControlUiFixture = Awaited<ReturnType<typeof createControlUiFixture>>;

export interface CatalogPageFixture {
  items: CatalogAsset[];
  nextPageToken?: string;
  hasMore?: boolean;
}

export interface ApiFailureFixture {
  path: string;
  method?: string;
  status?: number;
  body?: unknown;
  /** Number of matching requests to fail; omitted means every matching request. */
  times?: number;
}

export interface ControlUiFixtureOverrides {
  catalogPages?: Record<string, CatalogPageFixture[]>;
  apiFailures?: ApiFailureFixture[];
  grafanaDashboards?: Array<{
    uid: string;
    title: string;
    folderTitle?: string;
    folderUid?: string;
  }>;
}

export async function resetDiscovery(fixture: BrowserControlUiFixture): Promise<void> {
  await fixture.platform.discovery.refresh();
}

export async function installControlUiFixture(
  page: Page,
  fixture: BrowserControlUiFixture,
  overrides: ControlUiFixtureOverrides = {}
): Promise<void> {
  const remainingFailures =
    overrides.apiFailures?.map((failure) => failure.times ?? Infinity) ?? [];
  await page.route("**/grafana-api/search?type=dash-db", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        overrides.grafanaDashboards ?? [
          {
            uid: "parkbench-run-summary",
            title: "Run Summary",
            folderTitle: "Resources",
            type: "dash-db"
          }
        ]
      )
    })
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const failureIndex = overrides.apiFailures?.findIndex((failure, index) => {
      return (
        remainingFailures[index] > 0 &&
        failure.path === target.pathname &&
        (!failure.method || failure.method.toUpperCase() === request.method())
      );
    });
    if (failureIndex !== undefined && failureIndex >= 0) {
      const failure = overrides.apiFailures![failureIndex];
      remainingFailures[failureIndex] -= 1;
      await route.fulfill({
        status: failure.status ?? 503,
        contentType: "application/json",
        body: JSON.stringify(failure.body ?? { error: "fixture_service_unavailable" })
      });
      return;
    }
    if (target.pathname === "/api/v1/catalog/assets" && request.method() === "GET") {
      const pages = overrides.catalogPages?.[target.searchParams.get("category") ?? ""];
      if (pages?.length) {
        const token = target.searchParams.get("pageToken");
        const pageIndex = token ? pages.findIndex((item) => item.nextPageToken === token) + 1 : 0;
        const current = pages[pageIndex];
        if (current) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              contractVersion: "control-ui.v1",
              items: current.items,
              nextPageToken: current.nextPageToken,
              hasMore: current.hasMore ?? Boolean(current.nextPageToken)
            })
          });
          return;
        }
      }
    }
    const response = await fixture.app.inject({
      method: request.method() as any,
      url: `${target.pathname}${target.search}`,
      headers: request.headers(),
      payload: request.postData() ?? undefined
    });
    await route.fulfill({
      status: response.statusCode,
      contentType: String(response.headers["content-type"] ?? "application/json"),
      headers: response.headers["content-disposition"]
        ? { "content-disposition": String(response.headers["content-disposition"]) }
        : undefined,
      body: response.rawPayload ?? response.body
    });
  });
}

export async function seedTerminalMatrix(
  fixture: BrowserControlUiFixture
): Promise<{ experimentId: string; runIds: string[] }> {
  const preview = fixture.platform.controlUi.preview({
    runName: "test-run",
    scenario: { id: "crud-rest", version: "1.0.0" },
    dimensions: [
      { name: "-B", values: [500, 1000, 1500, 2000] },
      { name: "-B2", values: [500, 1000, 1500, 2000] }
    ],
    repetitions: 1
  });
  const experiment = fixture.platform.controlUi.submit({
    previewId: preview.previewId,
    confirm: true
  });
  const finishedAt = new Date().toISOString();
  for (const entry of experiment.runs) {
    const run = fixture.platform.repositories.getRun(entry.id)!;
    run.state = "SUCCEEDED";
    run.measurementValidity = "VALID";
    run.startedAt = finishedAt;
    run.finishedAt = finishedAt;
    run.cleanupStatus = "COMPLETE";
    run.completeness = { complete: true, requiredGaps: [], optionalWarnings: [] };
    run.summary = { requests: { completed: 16 }, summaries: [] };
    fixture.platform.repositories.saveRun(run);
  }
  return { experimentId: experiment.id, runIds: experiment.runs.map((run) => run.id) };
}
