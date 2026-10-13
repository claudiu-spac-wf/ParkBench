import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
export const GRAFANA_IMAGE = "grafana/grafana:12.1.1";
export const dockerFixture = (args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
export interface FixtureGrafana {
  url: string;
  dataVolume: string;
  request(route: string, body?: unknown): Promise<any>;
  stop(keepData?: boolean): void;
}
/** Named-volume fixture with an explicitly retained Grafana database for migration tests. */
export async function startFixtureGrafana(
  files: Record<string, string>,
  options: { dataVolume?: string; datasources?: string; nested?: boolean } = {}
): Promise<FixtureGrafana> {
  const suffix = randomUUID(),
    name = `parkbench-grafana-${suffix}`,
    configVolume = `parkbench-grafana-config-${suffix}`,
    dataVolume = options.dataVolume ?? `parkbench-grafana-db-${suffix}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-grafana-"));
  const importer = `${name}-import`;
  let stopped = false;
  const stop = (keepData = false) => {
    if (stopped) return;
    stopped = true;
    for (const c of [name, importer])
      try {
        dockerFixture(["rm", "-f", c]);
      } catch {}
    for (const v of [configVolume, ...(keepData ? [] : [dataVolume])])
      try {
        dockerFixture(["volume", "rm", v]);
      } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(directory, "dashboards", file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    fs.cpSync(path.resolve("deploy/grafana/frontend"), path.join(directory, "frontend"), {
      recursive: true
    });
    fs.mkdirSync(path.join(directory, "provisioning", "dashboards"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "provisioning", "dashboards", "dashboards.yml"),
      `apiVersion: 1\nproviders:\n  - name: ParkBench\n    type: file\n    disableDeletion: false\n    allowUiUpdates: false\n    updateIntervalSeconds: 30\n    options:\n      path: /fixtures/dashboards\n      foldersFromFilesStructure: ${options.nested !== false}\n`
    );
    if (options.datasources) {
      fs.mkdirSync(path.join(directory, "provisioning", "datasources"), { recursive: true });
      fs.writeFileSync(
        path.join(directory, "provisioning", "datasources", "datasources.yml"),
        options.datasources
      );
    }
    dockerFixture(["volume", "create", configVolume]);
    dockerFixture(["volume", "create", dataVolume]);
    dockerFixture([
      "create",
      "--name",
      importer,
      "--user",
      "0",
      "-v",
      `${configVolume}:/fixtures`,
      "--entrypoint",
      "sh",
      GRAFANA_IMAGE,
      "-c",
      "true"
    ]);
    dockerFixture(["cp", `${directory}/.`, `${importer}:/fixtures`]);
    dockerFixture(["rm", importer]);
    dockerFixture([
      "run",
      "-d",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--name",
      name,
      "--user",
      "0",
      "-p",
      "127.0.0.1::3000",
      "-v",
      `${configVolume}:/fixtures:ro`,
      "-v",
      `${dataVolume}:/var/lib/grafana`,
      "-e",
      "GF_PATHS_PROVISIONING=/fixtures/provisioning",
      "-e",
      "GF_SECURITY_ADMIN_USER=admin",
      "-e",
      "GF_SECURITY_ADMIN_PASSWORD=admin",
      "-e",
      "GF_ANALYTICS_REPORTING_ENABLED=false",
      "-e",
      "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
      "--entrypoint",
      "/bin/sh",
      GRAFANA_IMAGE,
      "/fixtures/frontend/start.sh"
    ]);
    const port = dockerFixture(["port", name, "3000"]).trim().split(":").at(-1),
      url = `http://127.0.0.1:${port}`;
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`,
          "content-type": "application/json"
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok)
        throw new Error(`grafana_fixture_${response.status}:${await response.text()}`);
      return response.json();
    };
    const deadline = Date.now() + 60000;
    const datasourceUids = [...(options.datasources ?? "").matchAll(/^\s+uid:\s*(\S+)\s*$/gm)].map(
      (match) => match[1]
    );
    while (Date.now() < deadline) {
      try {
        const health = await request("/api/health");
        if (health.database === "ok") {
          // Grafana can answer health before asynchronous datasource provisioning ends.
          const sources = datasourceUids.length ? await request("/api/datasources") : [];
          if (datasourceUids.every((uid) => sources.some((source: any) => source.uid === uid)))
            return { url, dataVolume, request, stop };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("grafana_fixture_ready_timeout");
  } catch (error) {
    stop(Boolean(options.dataVolume));
    throw error;
  }
}
