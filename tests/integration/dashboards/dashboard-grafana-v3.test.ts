import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParameterSnapshotQueries } from "../../../apps/control-plane/src/grafana/parameter-snapshots";
import { ArtifactStorage } from "../../../apps/control-plane/src/artifacts/storage";
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerGrafanaDatasourceRoutes } from "../../../apps/control-plane/src/grafana/prom-api";
import {
  generatedDashboards,
  panelsOf,
  interpolate,
  stagedDashboardFiles
} from "../../helpers/dashboards";
import { buildNativeFixture } from "./support/native-fixtures";
import { startFixturePrometheus } from "./support/fixture-prometheus";
import { startFixtureGrafana, FixtureGrafana } from "./support/fixture-grafana";
import { SavedSummaryQueries } from "../../../apps/control-plane/src/grafana/summary-results";
import { summaryHeader, summaryRow } from "../../helpers/summary";
import { ALIGNED_ANCHOR_MS } from "../../../apps/control-plane/src/grafana/alignment";
import { emitPanel } from "../../../packages/dashboards/src/emit";
const enabled = process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION === "1";
test(
  "replacement-only real Grafana executes all diagnostic and saved-summary targets through both configured datasources",
  { skip: !enabled, timeout: 300000 },
  async () => {
    const fixture = buildNativeFixture();
    const arrayEpoch = JSON.stringify(["2026-10-02T10:00:00.000Z", "2026-10-02T10:02:00.000Z"]);
    // A real entity name contains epoch; generated suffix cleanup must not sanitize it.
    fixture.openMetrics = fixture.openMetrics.replaceAll(
      'table="table-099"',
      'table="epoch-table-099"'
    );
    const directory = path.resolve(".parkbench/validation/feature020/legend-labels");
    fs.mkdirSync(directory, { recursive: true });
    const frameEvidence: any[] = [];
    const prom = await startFixturePrometheus(
        fixture.openMetrics.replace(/\n# EOF\s*$/, "\n") +
          fixture.openMetrics
            .split("\n")
            .filter((line) =>
              /^parkbench_openedge_db_(table_operations_total|index_blocks_(read|written)_total|buffer_pool_(logical|os)_reads_total)\{/.test(
                line
              )
            )
            .map((line) =>
              line.replace(
                'database_epoch="opaque-A"',
                `database_epoch=${JSON.stringify(arrayEpoch)}`
              )
            )
            .join("\n") +
          "\n" +
          fixture.openMetrics
            .split("\n")
            .filter(
              (line) =>
                /^parkbench_openedge_db_(table_operations_total|index_blocks_(read|written)_total)\{/.test(
                  line
                ) && line.includes('run_id="native-a"')
            )
            .filter((line) => Number(line.split(" ").at(-1)) >= fixture.start - 30)
            .map((line) => {
              const timestamp = Number(line.split(" ").at(-1));
              const jittered = timestamp === fixture.start - 25 ? timestamp + 0.65 : timestamp;
              return line
                .replace('run_id="native-a"', 'run_id="native-totals"')
                .replace('phase="measurement"', 'phase=""')
                .replace(/ [0-9]+$/, " " + jittered);
            })
            .join("\n") +
          "\n" +
          ["tie-b", "missing", "tie-a", "high"]
            .flatMap((name) => {
              const value = (
                { high: "12", "tie-a": "5", "tie-b": "5", missing: "NaN" } as Record<string, string>
              )[name];
              return Array.from(
                { length: 37 },
                (_, i) =>
                  `parkbench_legend_acceptance{run_id="native-a",name="${name}"} ${value} ${fixture.start - 60 + i * 5}`
              );
            })
            .join("\n") +
          "\n# EOF\n"
      ),
      app = Fastify();
    let grafana: FixtureGrafana | undefined;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grafana-snapshot-"));
    const storage = new ArtifactStorage(root);
    for (const runId of ["native-a", "native-b"])
      storage.write(
        `${runId}/params.json`,
        JSON.stringify({
          contractVersion: "db-parameter-snapshot.v1",
          runId,
          experimentId: "exp-test",
          variantId: "v1",
          repetition: 1,
          databaseName: "actual-db",
          attemptedAt: new Date((fixture.start - 300) * 1000).toISOString(),
          capturedAt: new Date((fixture.start - 299) * 1000).toISOString(),
          status: "complete",
          rowCount: 1,
          source: "_DbParams",
          rows: [
            {
              name: "-B",
              displayValue: "4096",
              numericValue: 4096,
              valueStatus: "recorded",
              dtype: 4,
              isDefault: false
            }
          ],
          verificationResults: []
        })
      );
    for (const status of ["empty", "partial", "unavailable"]) {
      const runId = `snapshot-${status}`;
      storage.write(
        `${runId}/params.json`,
        JSON.stringify({
          contractVersion: "db-parameter-snapshot.v1",
          runId,
          experimentId: "exp-test",
          variantId: "v1",
          repetition: 1,
          databaseName: "actual-db",
          attemptedAt: new Date((fixture.start - 300) * 1000).toISOString(),
          status,
          ...(status !== "unavailable"
            ? { capturedAt: new Date((fixture.start - 299) * 1000).toISOString() }
            : {}),
          rowCount: 0,
          source: "_DbParams",
          rows: [],
          verificationResults: [],
          reason: "fixture_status"
        })
      );
    }
    try {
      registerGrafanaDatasourceRoutes(app, {
        parameterSnapshots: new ParameterSnapshotQueries(
          {
            getRun: (id: string) => ({ id, experimentId: "exp-test" }),
            listArtifacts: (id: string) =>
              fs.existsSync(storage.safePath(`${id}/params.json`))
                ? [{ kind: "db_parameter_snapshot", path: `${id}/params.json` }]
                : []
          } as any,
          storage
        ),
        prometheusUrl: prom.url,
        timelines: {
          get: (runId) => ({
            runId,
            startedAt: (fixture.start - (runId === "native-totals" ? 40 : 0)) * 1000,
            endedAt:
              (fixture.end +
                (runId === "native-totals"
                  ? 40
                  : ["native-reset", "native-epochs"].includes(runId)
                    ? 1
                    : 0)) *
              1000,
            measurementStart: fixture.start * 1000,
            nativePublisher: "endpoint",
            continuousMetrics: runId === "native-totals",
            phases: [
              {
                phase: "measurement",
                start: fixture.start * 1000,
                end:
                  (fixture.end + (["native-reset", "native-epochs"].includes(runId) ? 1 : 0)) * 1000
              }
            ]
          }),
          list: () => [
            {
              runId: "native-a",
              startedAt: fixture.start * 1000,
              endedAt: fixture.end * 1000,
              measurementStart: fixture.start * 1000,
              nativePublisher: "endpoint",
              phases: [
                { phase: "measurement", start: fixture.start * 1000, end: fixture.end * 1000 }
              ]
            }
          ]
        },
        savedSummaries: new SavedSummaryQueries({
          read: () => ({ status: "READY", attemptToken: "fixture", header: summaryHeader() }),
          page: () => ({
            rows: [summaryRow()],
            totalRowCount: 1,
            hasMore: false,
            returnedRowCount: 1
          }),
          find: () => undefined,
          iterate: async function* () {
            yield summaryRow();
          }
        }),
        log: () => undefined
      });
      await app.listen({ host: "0.0.0.0", port: 0 });
      const port = (app.server.address() as any).port;
      const ds = `apiVersion: 1\ndatasources:\n  - name: Prometheus\n    uid: prometheus\n    type: prometheus\n    access: proxy\n    url: http://host.docker.internal:${new URL(prom.url).port}\n    isDefault: true\n  - name: ParkBench Runs\n    uid: parkbench-runs\n    type: prometheus\n    access: proxy\n    url: http://host.docker.internal:${port}/api/v1/grafana/prom\n`;
      const legendPanel = emitPanel(
        {
          id: "legend.acceptance",
          title: "Side legend acceptance",
          visual: "timeseries",
          category: "count",
          targets: [
            {
              expr: 'parkbench_legend_acceptance{run_id="native-a"}',
              legendFormat: "{{name}}"
            }
          ]
        } as any,
        "parkbench_runs",
        { x: 0, y: 0, w: 24, h: 10 },
        1
      );
      grafana = await startFixtureGrafana(
        {
          ...stagedDashboardFiles(),
          "layout-acceptance.json": JSON.stringify({
            uid: "layout-acceptance",
            title: "Layout acceptance",
            schemaVersion: 41,
            panels: [legendPanel],
            time: { from: "now-1h", to: "now" }
          })
        },
        { datasources: ds }
      );
      const sources = await grafana.request("/api/datasources");
      assert.deepEqual(sources.map((s: any) => s.uid).sort(), ["parkbench-runs", "prometheus"]);
      let queries = 0;
      for (const dashboard of Object.values(generatedDashboards()))
        for (const { panel } of panelsOf(dashboard))
          for (const target of panel.targets ?? []) {
            if (
              !panel.parkbench?.legacy &&
              !target.expr.startsWith("parkbench_saved_summary") &&
              !target.expr.startsWith("parkbench_table_rank") &&
              !target.expr.startsWith("parkbench_db_diagnostic")
            )
              continue;
            const expr = interpolate(target.expr, ["native-a"], 120)
              .replaceAll("$phase", "measurement")
              .replaceAll("$replica", "pas-1")
              .replaceAll("$table", ".*")
              .replaceAll("$__from", String(fixture.start * 1000))
              .replaceAll("$__to", String(fixture.end * 1000));
            const response = await grafana.request("/api/ds/query", {
              from: String(fixture.start * 1000),
              to: String(fixture.end * 1000),
              queries: [
                {
                  refId: "A",
                  datasource: { type: "prometheus", uid: "parkbench-runs" },
                  expr,
                  instant: !!target.instant,
                  range: !target.instant,
                  format: target.format ?? "time_series",
                  intervalMs: 5000,
                  maxDataPoints: 1000
                }
              ]
            });
            assert.equal(
              response.results.A.error,
              undefined,
              `${dashboard.title}/${panel.title}: ${response.results.A.error}`
            );
            if (panel.parkbench.panelId.startsWith("rs.index_")) {
              const numbers = response.results.A.frames.flatMap((frame: any) =>
                frame.schema.fields.flatMap((field: any, index: number) =>
                  field.type === "number"
                    ? frame.data.values[index].filter(
                        (value: any) => typeof value === "number" && Number.isFinite(value)
                      )
                    : []
                )
              );
              assert.ok(numbers.length > 0, panel.title);
              assert.ok(
                numbers.every(
                  (value: number) =>
                    Math.abs(
                      value -
                        (target.instant ? (target.expr.includes('aggregate="run"') ? 480 : 240) : 2)
                    ) < 1e-6
                ),
                `${panel.title}: ${numbers}`
              );
            }
            queries++;
          }
      assert.ok(queries > 90, `only ${queries} covered targets`);
      for (const status of ["empty", "partial", "unavailable", "pre_feature"]) {
        const runId = status === "pre_feature" ? "run-before-feature" : `snapshot-${status}`;
        const response = await grafana.request("/api/ds/query", {
          from: String(fixture.start * 1000),
          to: String(fixture.end * 1000),
          queries: [
            {
              refId: "A",
              datasource: { type: "prometheus", uid: "parkbench-runs" },
              expr: `parkbench_parameter_snapshot_status{run_id="${runId}"}`,
              instant: true,
              range: false,
              intervalMs: 5000,
              maxDataPoints: 1000
            }
          ]
        });
        assert.equal(response.results.A.error, undefined);
        assert.ok(
          JSON.stringify(response.results.A.frames).includes(status),
          `snapshot state ${status} missing`
        );
      }

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
          extraHTTPHeaders: {
            authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`
          }
        });
        await page.goto(
          `${grafana.url}/d/parkbench-host-resources?from=${fixture.start * 1000}&to=${fixture.end * 1000}`
        );
        await expect(page.getByText("native-a", { exact: true }).first()).toBeVisible({
          timeout: 30000
        });
        const link = page.getByRole("link", { name: "native-a", exact: true }).first();
        await expect(link).toBeVisible();
        assert.match(
          (await link.getAttribute("href"))!,
          new RegExp(`from=${fixture.start * 1000}.*to=${fixture.end * 1000}`)
        );
        await link.click();
        await expect(page).toHaveURL(/var-picker_run=native-a/);

        const generated = generatedDashboards();
        const legendCases: Array<[string, string]> = [
          ...["reads", "writes"].flatMap(
            (operation) =>
              [
                ["parkbench-run-summary", `DB table ${operation} (records/s)`],
                ["parkbench-run-summary", `DB table ${operation} (total)`],
                ["parkbench-run-summary", `DB index ${operation} (blocks/s)`],
                ["parkbench-run-summary", `DB index ${operation} (total)`]
              ] as Array<[string, string]>
          ),
          ["parkbench-database-activity", "Table read activity"],
          ["parkbench-database-activity", "Logical reads per second"],
          ["parkbench-database-activity", "Cumulative cache hit ratio"]
        ];
        for (const [uid, title] of legendCases) {
          const panel = panelsOf(generated[uid]).find(({ panel }) => panel.title === title)!.panel;
          const target = panel.targets[0];
          const expr = interpolate(target.expr, ["native-a", "native-b"], 120)
            .replaceAll("$phase", "measurement")
            .replaceAll("$table", ".*")
            .replaceAll("$__from", String(ALIGNED_ANCHOR_MS))
            .replaceAll("$__to", String(ALIGNED_ANCHOR_MS + 120000));
          const response = await grafana.request("/api/ds/query", {
            from: String(ALIGNED_ANCHOR_MS),
            to: String(ALIGNED_ANCHOR_MS + 120000),
            queries: [
              {
                refId: "A",
                datasource: { type: "prometheus", uid: "parkbench-runs" },
                expr,
                legendFormat: target.legendFormat,
                instant: !!target.instant,
                range: !target.instant,
                format: "time_series",
                intervalMs: 5000,
                maxDataPoints: 1000
              }
            ]
          });
          assert.equal(response.results.A.error, undefined, title);
          const frames = response.results.A.frames;
          const isTable = target.expr.startsWith("parkbench_table_rank");
          const expectedCount = isTable ? 44 : 4; // top ten + Other, per run and lifetime
          assert.equal(
            frames.length,
            expectedCount,
            `${title}: distinct lifetimes remain separate`
          );
          const identities = new Set<string>();
          const legends: string[] = [];
          const values: any[] = [];
          for (const frame of frames) {
            const index = frame.schema.fields.findIndex((field: any) => field.type === "number");
            const field = frame.schema.fields[index];
            const labels = field.labels;
            assert.ok(["native-a", "native-b"].includes(labels.run_id), title);
            assert.ok(["opaque-A", arrayEpoch].includes(labels.database_epoch), title);
            identities.add(JSON.stringify(labels));
            const name = field.config.displayNameFromDS;
            assert.doesNotMatch(name, / epoch |opaque-A|2026-10-02T/, title);
            const expectedName = target.legendFormat
              .replace(" epoch {{database_epoch}}", "")
              .replace(/\{\{([^}]+)\}\}/g, (_: string, key: string) => labels[key] ?? "")
              .trim();
            assert.equal(name, expectedName, `${title}: preserved readable run/entity template`);
            legends.push(name);
            const numbers = frame.data.values[index].filter(
              (value: any) => typeof value === "number" && Number.isFinite(value)
            );
            assert.ok(numbers.length, `${title}: original values retained`);
            if (isTable) {
              const tableRate =
                labels.table === "Other"
                  ? title.includes("write")
                    ? 12555
                    : 4098
                  : title.includes("write")
                    ? 3 * (101 - Number(labels.table.slice(-3)))
                    : Number(labels.table.slice(-3)) + 1;
              const expected = tableRate * (target.instant ? 120 : 1);
              assert.ok(
                numbers.every((value: number) => Math.abs(value - expected) < 1e-6),
                `${title}/${labels.table}: ${numbers}`
              );
            } else {
              const expected =
                title === "Cumulative cache hit ratio" ? 0 : target.instant ? 240 : 2;
              assert.ok(
                numbers.every((value: number) => Math.abs(value - expected) < 1e-6),
                `${title}: ${numbers}`
              );
            }
            values.push({
              labels,
              displayName: name,
              count: numbers.length,
              first: numbers[0],
              last: numbers.at(-1)
            });
          }
          assert.equal(identities.size, expectedCount, title);
          assert.equal(
            new Set(legends).size,
            expectedCount / 2,
            `${title}: equal legends do not merge series`
          );
          for (const name of new Set(legends))
            assert.equal(legends.filter((value) => value === name).length, 2);
          if (isTable && /read/.test(title))
            assert.ok(legends.includes("native-a epoch-table-099"));
          const expectedUnit =
            title === "Cumulative cache hit ratio"
              ? "percentunit"
              : title.includes("index")
                ? target.instant
                  ? "suffix:blocks"
                  : "suffix:blocks/s"
                : isTable
                  ? "short"
                  : "ops/s";
          assert.equal(panel.fieldConfig.defaults.unit, expectedUnit, title);
          frameEvidence.push({
            uid,
            title,
            count: frames.length,
            unit: panel.fieldConfig.defaults.unit,
            values
          });

          const hasRunTotal = uid === "parkbench-run-summary" && target.instant;
          if (hasRunTotal) {
            assert.equal(panel.targets.length, 2, title + ": additive Total target");
            const totalTarget = panel.targets[1];
            const totalResponse = await grafana.request("/api/ds/query", {
              from: String(ALIGNED_ANCHOR_MS),
              to: String(ALIGNED_ANCHOR_MS + 120000),
              queries: [
                {
                  refId: "B",
                  datasource: { type: "prometheus", uid: "parkbench-runs" },
                  expr: expr.replace(/}$/, ',aggregate="run"}'),
                  legendFormat: totalTarget.legendFormat,
                  instant: true,
                  range: false,
                  format: "time_series",
                  intervalMs: 5000,
                  maxDataPoints: 1000
                }
              ]
            });
            assert.equal(totalResponse.results.B.error, undefined, title);
            assert.equal(totalResponse.results.B.frames.length, 2, "one Total per selected run");
            for (const frame of totalResponse.results.B.frames) {
              const index = frame.schema.fields.findIndex((field: any) => field.type === "number");
              const field = frame.schema.fields[index];
              const run = field.labels.run_id;
              const expected = values
                .filter((v) => v.labels.run_id === run)
                .reduce((sum, v) => sum + v.first, 0);
              assert.equal(field.config.displayNameFromDS, run + " Total");
              assert.equal(field.labels.aggregation, "run_total");
              assert.equal(field.labels.database_epoch, undefined);
              assert.equal(
                frame.data.values[index][0],
                expected,
                title + ": sum every breakdown once"
              );
            }
          }

          await page.goto(
            `${grafana.url}/d-solo/${uid}/readable-legends?panelId=${panel.id}&var-run_id=native-a&var-run_id=native-b&var-phase=measurement&from=${ALIGNED_ANCHOR_MS}&to=${ALIGNED_ANCHOR_MS + 120000}`
          );
          if (target.instant) {
            await expect(page.locator('[data-testid="data-testid Bar gauge value"]')).toHaveCount(
              expectedCount + (hasRunTotal ? 2 : 0),
              { timeout: 30000 }
            );
            for (const name of new Set(legends))
              await expect(page.getByText(name, { exact: true })).toHaveCount(2);
            if (hasRunTotal)
              for (const run of ["native-a", "native-b"])
                await expect(page.getByText(run + " Total", { exact: true })).toHaveCount(1);
          } else {
            const rows = page.getByRole("table").locator("tbody tr");
            await expect(rows).toHaveCount(expectedCount, { timeout: 30000 });
            // Grafana renders duplicate display names as separate legend rows.
            const rendered = (await rows.locator("td:first-child").allTextContents()).map((value) =>
              value.trim()
            );
            assert.deepEqual([...rendered].sort(), [...legends].sort(), title);
          }
          await expect(page.getByText(/ epoch opaque-A| epoch \[|2026-10-02T10:/)).toHaveCount(0);
          const screenshot = `${uid}-${panel.parkbench.panelId.replaceAll(".", "-")}.png`;
          await page.screenshot({ path: path.join(directory, screenshot), fullPage: true });
        }
        const namedDirectory = path.resolve(
          ".parkbench/validation/feature021/p1/named-latches-grafana"
        );
        fs.mkdirSync(namedDirectory, { recursive: true });
        const namedFrames: any[] = [];
        for (const { panel } of panelsOf(generated["parkbench-database-concurrency"]).filter(
          ({ panel }) => panel.parkbench.panelId.startsWith("latch.named.")
        )) {
          const target = panel.targets[0];
          const expression = interpolate(target.expr, ["native-a", "native-b"], 120)
            .replaceAll("$phase", "measurement")
            .replaceAll("$__from", String(ALIGNED_ANCHOR_MS))
            .replaceAll("$__to", String(ALIGNED_ANCHOR_MS + 120000));
          const response = await grafana.request("/api/ds/query", {
            from: String(ALIGNED_ANCHOR_MS),
            to: String(ALIGNED_ANCHOR_MS + 120000),
            queries: [
              {
                refId: "A",
                datasource: { type: "prometheus", uid: "parkbench-runs" },
                expr: expression,
                legendFormat: target.legendFormat,
                instant: !!target.instant,
                range: !target.instant,
                format: "time_series",
                intervalMs: 5000,
                maxDataPoints: 1000
              }
            ]
          });
          assert.equal(response.results.A.error, undefined, panel.title);
          const frames = response.results.A.frames;
          assert.equal(frames.length, 6, panel.title + ": three instances per run");
          for (const frame of frames) {
            const index = frame.schema.fields.findIndex((f: any) => f.type === "number");
            const labels = frame.schema.fields[index].labels;
            assert.ok(["native-a", "native-b"].includes(labels.run_id));
            assert.ok(["buffer", "transaction", "idle"].includes(labels.latch_name));
            assert.equal(labels.database_epoch, "named-epoch-a");
            const numbers = frame.data.values[index].filter(
              (v: any) => typeof v === "number" && Number.isFinite(v)
            );
            assert.ok(numbers.length, panel.title);
            if (target.instant) {
              const expected = (
                panel.parkbench.panelId.includes("duration")
                  ? { buffer: 2, transaction: 5, idle: 0 }
                  : { buffer: 10, transaction: 30, idle: 0 }
              )[labels.latch_name as "buffer" | "transaction" | "idle"];
              assert.ok(
                numbers.every((v: number) => Math.abs(v - expected) < 1e-6),
                `${panel.title}/${labels.latch_name}: ${numbers}`
              );
            } else assert.ok(numbers.every((v: number) => v >= 0));
            assert.doesNotMatch(frame.schema.fields[index].config.displayNameFromDS, /epoch/);
          }
          namedFrames.push({
            panelId: panel.parkbench.panelId,
            unit: panel.fieldConfig.defaults.unit,
            frames
          });
          await page.goto(
            `${grafana.url}/d-solo/parkbench-database-concurrency/named-latches?panelId=${panel.id}&var-run_id=native-a&var-run_id=native-b&var-phase=measurement&from=${ALIGNED_ANCHOR_MS}&to=${ALIGNED_ANCHOR_MS + 120000}`
          );
          if (target.instant)
            await expect(page.locator('[data-testid="data-testid Bar gauge value"]')).toHaveCount(
              6,
              { timeout: 30000 }
            );
          else
            await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(6, {
              timeout: 30000
            });
          for (const runId of ["native-a", "native-b"])
            await expect(page.getByText(new RegExp(runId + " buffer")).first()).toBeVisible();
          await page.screenshot({
            path: path.join(namedDirectory, panel.parkbench.panelId + ".png"),
            fullPage: true
          });
        }
        for (const { panel } of panelsOf(generated["parkbench-database-concurrency"]).filter(
          ({ panel }) =>
            panel.parkbench.panelId === "latch.named.wait_total" ||
            panel.parkbench.panelId === "latch.named.duration_total"
        )) {
          const target = panel.targets[0];
          const expression = interpolate(target.expr, ["native-reset", "native-epochs"], 120)
            .replaceAll("$phase", "measurement")
            .replaceAll("$__from", String(ALIGNED_ANCHOR_MS))
            .replaceAll("$__to", String(ALIGNED_ANCHOR_MS + 120000));
          const response = await grafana.request("/api/ds/query", {
            from: String(ALIGNED_ANCHOR_MS),
            to: String(ALIGNED_ANCHOR_MS + 120000),
            queries: [
              {
                refId: "A",
                datasource: { type: "prometheus", uid: "parkbench-runs" },
                expr: expression,
                legendFormat: target.legendFormat,
                instant: true,
                range: false,
                format: "time_series",
                intervalMs: 5000,
                maxDataPoints: 1000
              }
            ]
          });
          assert.equal(response.results.A.error, undefined);
          assert.equal(response.results.A.frames.length, 2);
          for (const frame of response.results.A.frames) {
            const index = frame.schema.fields.findIndex((f: any) => f.type === "number");
            const labels = frame.schema.fields[index].labels;
            const expected = panel.parkbench.panelId.includes("duration")
              ? labels.run_id === "native-reset"
                ? 0.7
                : 7
              : labels.run_id === "native-reset"
                ? 7
                : 40;
            assert.ok(
              Math.abs(frame.data.values[index][0] - expected) < 1e-6,
              `${labels.run_id}/${panel.title}: reduce each epoch before name aggregation`
            );
            if (labels.run_id === "native-epochs")
              assert.equal(labels.database_epochs, '["epoch-one","epoch-two"]');
          }
          namedFrames.push({
            case: "reset-and-epochs",
            panelId: panel.parkbench.panelId,
            frames: response.results.A.frames
          });
          await page.goto(
            `${grafana.url}/d-solo/parkbench-database-concurrency/named-identities?panelId=${panel.id}&var-run_id=native-reset&var-run_id=native-epochs&var-phase=measurement&from=${ALIGNED_ANCHOR_MS}&to=${ALIGNED_ANCHOR_MS + 120000}`
          );
          await expect(page.locator('[data-testid="data-testid Bar gauge value"]')).toHaveCount(2, {
            timeout: 30000
          });
          await page.screenshot({
            path: path.join(namedDirectory, panel.parkbench.panelId + "-reset-epochs.png"),
            fullPage: true
          });
        }
        fs.writeFileSync(
          path.join(namedDirectory, "frames.json"),
          JSON.stringify(namedFrames, null, 2)
        );
        fs.writeFileSync(
          path.join(directory, "distinct-frames.json"),
          JSON.stringify(frameEvidence, null, 2)
        );

        for (const title of [
          "DB table reads (total)",
          "DB table writes (total)",
          "DB index reads (total)",
          "DB index writes (total)"
        ]) {
          const panel = panelsOf(generatedDashboards()["parkbench-run-summary"]).find(
            ({ panel }) => panel.title === title
          )!.panel;
          await page.goto(
            `${grafana.url}/d-solo/parkbench-run-summary/totals?panelId=${panel.id}&var-run_id=native-totals&var-phase=$__all&from=${(fixture.start - 40) * 1000}&to=${(fixture.end + 40) * 1000}`
          );
          const numericValues = page.locator('[data-testid="data-testid Bar gauge value"]');
          await expect(numericValues.first()).toBeVisible({ timeout: 30000 });
          if (title.startsWith("DB table"))
            await expect(page.getByText(/^native-totals /).first()).toBeVisible();
          else
            assert.deepEqual(await numericValues.allTextContents(), ["300 blocks", "300 blocks"]);
          await expect(page.getByText("native-totals Total", { exact: true })).toHaveCount(1);
          await expect(page.getByText(/No data|NaN/)).toHaveCount(0);
          const values = await numericValues.allTextContents();
          assert.ok(
            values.length > 0 && values.every((value) => /[0-9]/.test(value)),
            title + ": rendered numeric totals"
          );
        }

        await page.goto(
          `${grafana.url}/d/parkbench-run-summary?var-run_id=native-a&var-phase=measurement&var-notice_time_range=BAD-URL-NOTICE&from=${fixture.start * 1000}&to=${fixture.end * 1000}`
        );
        await expect(
          page.getByText(/^No runs are excluded from aligned charts\. Last successful check/)
        ).toBeVisible({ timeout: 30000 });
        await expect(
          page.getByText(
            /^Time range matches the selected runs \(clock time\)\. Last successful check/
          )
        ).toBeVisible();
        for (
          let index = 0;
          index < 5 &&
          !(await page
            .getByRole("heading", { name: "DB tables and indexes", exact: true })
            .count());
          index++
        ) {
          await page.mouse.move(1100, 800);
          await page.mouse.wheel(0, 650);
          await page.waitForTimeout(100);
        }
        await expect(
          page.getByRole("heading", { name: "DB tables and indexes", exact: true })
        ).toBeVisible();
        await expect(page.getByText("Saved measurement results", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Saved table activity", { exact: true })).toHaveCount(0);
        await page.screenshot({
          path: path.join(directory, "run-summary-grafana.png"),
          fullPage: true
        });
        await page.goto(
          `${grafana.url}/d/parkbench-run-summary?var-run_id=native-a&var-run_id=native-b&from=${fixture.start * 1000}&to=${fixture.end * 1000}`
        );
        await expect(page.getByText(/Reset the range to elapsed time/)).toBeVisible({
          timeout: 30000
        });

        let noticeFailures = 0;
        await page.route("**/api/**", (route) => {
          if (
            (route.request().url() + (route.request().postData() ?? "")).includes(
              "parkbench_run_notice_text"
            )
          ) {
            noticeFailures++;
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ message: "Notice service unavailable" })
            });
          }
          return route.continue();
        });
        await page.getByRole("button", { name: "Move time range forwards", exact: true }).click();
        await expect.poll(() => noticeFailures).toBeGreaterThan(0);
        await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
        await expect(
          page
            .getByText("Notice unavailable: refresh failed. Refresh the dashboard to retry.", {
              exact: true
            })
            .first()
        ).toBeVisible();
        await expect(
          page.getByText(/Last successful check for runs native-a, native-b/).first()
        ).toBeHidden();
        fs.writeFileSync(
          path.join(directory, "notice-failure-dom.txt"),
          await page.locator("body").innerText()
        );
        await page.unroute("**/api/**");
        await page.getByRole("button", { name: "Move time range backwards", exact: true }).click();
        await expect(
          page.getByText(/Last successful check for runs native-a, native-b/).first()
        ).toBeVisible();
        const layouts: any[] = [];
        for (const width of [1440, 760]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `${grafana.url}/d-solo/layout-acceptance/legend?panelId=1&from=${fixture.start * 1000}&to=${fixture.end * 1000}`
          );
          const table = page.getByRole("table");
          await expect(table).toBeVisible({ timeout: 30000 });
          await expect
            .poll(async () =>
              (await table.locator("tbody tr td:first-child").allTextContents()).map((value) =>
                value.trim()
              )
            )
            .toEqual(["high", "tie-a", "tie-b", "missing"]);
          const plot = await page.locator(".uplot").boundingBox(),
            legend = await table.boundingBox();
          fs.writeFileSync(
            path.join(directory, `legend-diagnostic-${width}.json`),
            JSON.stringify(
              {
                plot,
                legend,
                dimensions: await page.evaluate(() => ({
                  body: document.body.clientWidth,
                  html: document.documentElement.clientWidth,
                  scroll: document.documentElement.scrollWidth,
                  minWidth: getComputedStyle(document.body).minWidth,
                  styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
                    (link) => link.getAttribute("href")
                  ),
                  wrapper: document
                    .querySelector(".uplot")
                    ?.parentElement?.parentElement?.outerHTML.slice(0, 2000)
                }))
              },
              null,
              2
            )
          );
          await page.screenshot({
            path: path.join(directory, `legend-diagnostic-${width}.png`),
            fullPage: true
          });
          assert.ok(
            plot && legend && legend.x >= plot.x + plot.width - 2,
            "legend beside plot at " + width
          );
          const dimensions = await page.evaluate(() => ({
            body: document.body.clientWidth,
            scroll: document.documentElement.scrollWidth,
            viewport: window.innerWidth
          }));
          if (width < 992)
            assert.ok(dimensions.body >= 992 && dimensions.scroll > dimensions.viewport);
          const screenshot = path.join(directory, `legend-${width}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          layouts.push({
            width,
            dimensions,
            plot,
            legend,
            rows: await table.locator("tbody tr").allTextContents(),
            screenshot
          });
        }
        fs.writeFileSync(
          path.join(directory, "us6-grafana.json"),
          JSON.stringify(
            {
              ok: true,
              grafana: "12.1.1",
              renderedPicker: true,
              textNotices: true,
              failedRefreshScopeRetained: true,
              layouts,
              note: "Real production datasource orders finite means descending, canonical ties and unavailable last; chart pages scroll horizontally below 992px."
            },
            null,
            2
          )
        );
      } finally {
        await browser.close();
      }

      const ambient = await grafana.request("/api/ds/query", {
        from: String(fixture.start * 1000),
        to: String(fixture.end * 1000),
        queries: [
          {
            refId: "A",
            datasource: { type: "prometheus", uid: "prometheus" },
            expr: 'parkbench_openedge_db_table_operations_total{run_id="native-a",operation="read"}',
            instant: true,
            range: false,
            intervalMs: 5000,
            maxDataPoints: 1000
          }
        ]
      });
      assert.equal(ambient.results.A.error, undefined);
    } finally {
      grafana?.stop();
      await app.close();
      prom.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
