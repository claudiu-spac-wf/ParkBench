import test from "node:test";
import assert from "node:assert/strict";
import frozen from "../../fixtures/grafana-dashboards/coverage/legacy-v1.json";
import { stagedDashboardFiles } from "../../helpers/dashboards";
import { DASHBOARD_CATALOG } from "../../../packages/dashboards/src/model";
import { startFixtureGrafana, dockerFixture, FixtureGrafana } from "./support/fixture-grafana";
import { resolveOpen } from "../../../apps/control-plane/src/grafana/open-redirect";
const enabled = process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION === "1";
async function assertFinal(f: FixtureGrafana, manual = false) {
  let search: any[] = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    search = await f.request("/api/search?type=dash-db");
    if (
      search.length === 10 + Number(manual) &&
      DASHBOARD_CATALOG.every((e) =>
        search.some((s) => s.uid === e.uid && s.folderTitle === e.folder)
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.deepEqual(
    search
      .filter((e) => e.uid !== "unrelated-manual")
      .map((e) => e.uid)
      .sort(),
    DASHBOARD_CATALOG.map((e) => e.uid).sort()
  );
  for (const entry of DASHBOARD_CATALOG) {
    const match = search.filter((e) => e.uid === entry.uid);
    assert.equal(match.length, 1);
    assert.equal(match[0].folderTitle, entry.folder);
    assert.equal((await f.request(`/api/dashboards/uid/${entry.uid}`)).meta.provisioned, true);
  }
  if (manual) assert.equal(search.filter((e) => e.uid === "unrelated-manual").length, 1);
  const gone = await fetch(`${f.url}/api/dashboards/uid/parkbench-benchmark-overview`, {
    headers: { authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}` }
  });
  assert.equal(gone.status, 404);
  return search.map((e) => [e.uid, e.folderUid]);
}
test(
  "fresh Grafana installation has exactly ten generated dashboards in Resources/Database/PAS",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const f = await startFixtureGrafana(stagedDashboardFiles());
    try {
      await assertFinal(f);
    } finally {
      f.stop();
    }
  }
);
test(
  "retained Grafana database moves all ten legacy files, keeps manual dashboards and stays stable across two reloads",
  { skip: !enabled, timeout: 240000 },
  async () => {
    let f = await startFixtureGrafana(
      Object.fromEntries(frozen.originals.map((e) => [e.path, JSON.stringify(e.dashboard)])),
      { nested: false }
    );
    const volume = f.dataVolume;
    try {
      let original: any[] = [];
      const initialDeadline = Date.now() + 60000;
      while (Date.now() < initialDeadline) {
        original = await f.request("/api/search?type=dash-db");
        if (original.length === 10) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(original.length, 10);
      await f.request("/api/dashboards/db", {
        dashboard: {
          uid: "unrelated-manual",
          title: "Unrelated manual dashboard",
          schemaVersion: 41,
          panels: []
        },
        overwrite: true
      });
      f.stop(true);
      f = await startFixtureGrafana(stagedDashboardFiles(), { dataVolume: volume });
      const expected = await assertFinal(f, true);
      for (let i = 0; i < 2; i++) {
        await f.request("/api/admin/provisioning/dashboards/reload", {});
        assert.deepEqual(await assertFinal(f, true), expected);
      }
      const redirect = resolveOpen(
        new URLSearchParams({ dashboard: "parkbench-benchmark-overview", run_id: "old-run" }),
        {
          grafanaUrl: f.url,
          timelines: {
            get: () => ({
              runId: "old-run",
              startedAt: Date.now() - 10000,
              endedAt: Date.now(),
              measurementStart: Date.now() - 5000,
              phases: []
            }),
            list: () => []
          }
        }
      );
      assert.equal(redirect.status, 302);
      assert.ok("location" in redirect && redirect.location.includes("/d/parkbench-run-summary"));
    } finally {
      f.stop();
      try {
        dockerFixture(["volume", "rm", volume]);
      } catch {}
    }
  }
);
