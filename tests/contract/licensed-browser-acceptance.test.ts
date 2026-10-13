import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createSeedFixture } from "../helpers/seed";

const root = process.cwd();
const gateUrl = pathToFileURL(path.join(root, "scripts/openedge/licensed-ui-preflight.mjs")).href;

async function loadGate(): Promise<any> {
  const nativeImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<any>;
  return nativeImport(gateUrl);
}

function licensedFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-licensed-ui-"));
  const license = path.join(temporaryRoot, "progress.cfg");
  const progress = path.join(temporaryRoot, "progress-assets");
  const seedsRoot = path.join(temporaryRoot, "seeds");
  const applicationArchive = path.join(temporaryRoot, "oepas1.zip");
  const manifest = path.join(temporaryRoot, "manifest.json");
  const browser = path.join(temporaryRoot, "chromium");
  fs.mkdirSync(progress);
  fs.writeFileSync(license, "licensed bytes");
  fs.writeFileSync(path.join(progress, "DATABASE"), "db assets");
  fs.writeFileSync(path.join(progress, "PASOE"), "pas assets");
  createSeedFixture(seedsRoot, "one_gb_lnx");
  fs.writeFileSync(applicationArchive, "runner archive");
  fs.writeFileSync(browser, "browser executable");
  fs.chmodSync(browser, 0o755);
  const images = {
    db: "parkbench/openedge-db:12.8.11@sha256:" + "1".repeat(64),
    pas: "parkbench/openedge-pasoe:12.8.11@sha256:" + "2".repeat(64),
    observer: "parkbench/observer:1.0.0@sha256:" + "3".repeat(64),
    supportObserver: "parkbench/observer-runtime:1.0.0@sha256:" + "5".repeat(64),
    loadgen: "parkbench/loadgen:1.0.0@sha256:" + "4".repeat(64)
  };
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      imageStage: "final",
      parkBenchReady: true,
      db: { reference: images.db },
      pasoe: { reference: images.pas },
      observer: { reference: images.observer }
    })
  );
  const env = {
    PARKBENCH_OPENEDGE_LICENSE_PATH: license,
    PARKBENCH_OPENEDGE_PROGRESS_ROOT: progress,
    PARKBENCH_DISCOVERY_SEEDS_ROOT: seedsRoot,
    PARKBENCH_OPENEDGE_DEFAULT_SEED: "one_gb_lnx",
    PARKBENCH_OPENEDGE_APP_ARCHIVE: applicationArchive,
    PARKBENCH_OPENEDGE_IMAGE_MANIFEST: manifest,
    PARKBENCH_OPENEDGE_IMAGE_STAGE: "final",
    PARKBENCH_OPENEDGE_PARKBENCH_READY: "true",
    PARKBENCH_OPENEDGE_DB_IMAGE: images.db,
    PARKBENCH_OPENEDGE_PAS_IMAGE: images.pas,
    PARKBENCH_OPENEDGE_OBSERVER_IMAGE: images.observer,
    PARKBENCH_OBSERVER_IMAGE: images.supportObserver,
    PARKBENCH_LOADGEN_IMAGE: images.loadgen,
    PARKBENCH_OPENEDGE_DB_BASE_IMAGE: "progresssoftware/prgs-oedb:12.8.11_ent",
    PARKBENCH_OPENEDGE_PAS_BASE_IMAGE: "progresssoftware/prgs-pasoe:12.8.11",
    PARKBENCH_OPENEDGE_JDK_IMAGE: "eclipse-temurin:17.0.20_8-jdk",
    PARKBENCH_OPENEDGE_COMPILER: "/usr/bin/true",
    PARKBENCH_LICENSED_UI_URL: "http://127.0.0.1:13002/"
  };
  const services = [
    "control-plane",
    "web",
    "prometheus",
    "grafana",
    "cadvisor",
    "node-exporter"
  ].map((Service) => ({ Service, State: "running", Health: "healthy" }));
  const readyAsset = (kind: string, reference: string) => ({
    id: `${kind}-${reference}`,
    kind,
    immutableRef: reference,
    sourceRef: reference,
    provenance: { reference },
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED"
  });
  const catalog = [
    readyAsset("database_image", images.db),
    readyAsset("pas_image", images.pas),
    readyAsset("observer_image", images.observer),
    readyAsset("observer_image", images.supportObserver),
    readyAsset("loadgen_image", images.loadgen),
    readyAsset("seed", "input:seeds/one_gb_lnx"),
    readyAsset("archive", "input:archives/oepas1.zip")
  ];
  const runCommand = async (command: string, args: string[]) => {
    if (command === "docker" && args.includes("ps")) return JSON.stringify(services);
    if (command === "docker" && args[0] === "image")
      return JSON.stringify([{ Id: `sha256:${"a".repeat(64)}` }]);
    return "preflight fixture passed";
  };
  const fetchImpl = async (input: string | URL) => {
    const url = new URL(input);
    const body =
      url.pathname === "/api/v1/overview"
        ? { health: { prometheus: "healthy", docker: "healthy" } }
        : url.pathname === "/api/v1/catalog/assets"
          ? { items: catalog, hasMore: false }
          : url.pathname === "/api/v1/scenarios"
            ? { scenarios: [{ id: "parkbench-bank-mix", version: "1.0.0" }] }
            : url.pathname === "/api/v1/ui-options"
              ? { credentialReferences: [] }
              : {};
    return {
      ok: url.pathname === "/" || url.pathname.startsWith("/api/v1/"),
      json: async () => body
    };
  };
  return {
    temporaryRoot,
    env,
    images,
    services,
    browser,
    runCommand,
    fetchImpl,
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
  };
}

describe("licensed browser acceptance preflight", () => {
  it("accepts environment-owned images without retired image catalog entries or credential selectors", async () => {
    const gate = await loadGate();
    const fixture = licensedFixture();
    try {
      await assert.doesNotReject(
        gate.licensedUiPreflight({
          root,
          env: fixture.env,
          runCommand: fixture.runCommand,
          browserExecutablePath: fixture.browser,
          fetchImpl: async (input: string | URL) => {
            const response = await fixture.fetchImpl(input);
            const body: any = await response.json();
            if (new URL(input).pathname === "/api/v1/catalog/assets")
              body.items = body.items.filter((asset: any) =>
                ["seed", "archive"].includes(asset.kind)
              );
            if (new URL(input).pathname === "/api/v1/ui-options") {
              delete body.credentialReferences;
              body.databaseParameters = { parameters: [] };
            }
            return { ...response, json: async () => body };
          }
        })
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("does not require a seed baseline checksum", async () => {
    const gate = await loadGate();
    const fixture = licensedFixture();
    try {
      await assert.doesNotReject(
        gate.licensedUiPreflight({
          root,
          env: fixture.env,
          runCommand: fixture.runCommand,
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: fixture.browser
        })
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the deployed browser journey on real UI requests and requires both licensed paths", () => {
    const journey = fs.readFileSync(
      path.join(root, "tests/browser/licensed-parkbench.spec.ts"),
      "utf8"
    );
    const runner = fs.readFileSync(path.join(root, "scripts/run-licensed-browser.mjs"), "utf8");
    assert.match(journey, /State: \$\{terminal\.state\}/);
    assert.match(journey, /Load more preview cells/);
    assert.match(journey, /new Set\(runIds\)/);
    assert.match(journey, /Cancel/);
    assert.doesNotMatch(journey, /page\.route\(|route\.fulfill\(/);
  });
  it("fails closed for absent and invalid private OpenEdge inputs without revealing paths", async () => {
    const gate = await loadGate();
    const fixture = licensedFixture();
    try {
      const missing = { ...fixture.env } as Record<string, string | undefined>;
      delete missing.PARKBENCH_OPENEDGE_DEFAULT_SEED;
      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: missing,
          runCommand: fixture.runCommand,
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: fixture.browser
        }),
        /licensed_ui_setting_required:PARKBENCH_OPENEDGE_DEFAULT_SEED/
      );
      const unknownSeed = { ...fixture.env, PARKBENCH_OPENEDGE_DEFAULT_SEED: "missing_seed" };
      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: unknownSeed,
          runCommand: fixture.runCommand,
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: fixture.browser
        }),
        /licensed_ui_seed_unavailable/
      );

      const invalid = {
        ...fixture.env,
        PARKBENCH_OPENEDGE_LICENSE_PATH: path.join(
          fixture.temporaryRoot,
          "private-sentinel-license"
        )
      };
      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: invalid,
          runCommand: fixture.runCommand,
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: fixture.browser
        }),
        (error: Error) => {
          assert.match(error.message, /licensed_input_unavailable:PARKBENCH_OPENEDGE_LICENSE_PATH/);
          assert.doesNotMatch(error.message, /private-sentinel-license/);
          return true;
        }
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("fails when required platform services or disk-I/O sources are unavailable", async () => {
    const gate = await loadGate();
    const fixture = licensedFixture();
    try {
      const missingServices = fixture.services.filter(({ Service }: any) => Service !== "cadvisor");
      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: fixture.env,
          runCommand: async (command: string, args: string[]) =>
            command === "docker" && args.includes("ps")
              ? JSON.stringify(missingServices)
              : fixture.runCommand(command, args),
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: fixture.browser
        }),
        /licensed_platform_services_not_healthy/
      );

      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: fixture.env,
          runCommand: async (command: string, args: string[]) => {
            if (command === "npm" && args.includes("--scenario"))
              throw new Error("disk_io_sources_unavailable:private-sentinel");
            return fixture.runCommand(command, args);
          },
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: fixture.browser
        }),
        (error: Error) => {
          assert.match(error.message, /disk_io_sources_unavailable/);
          assert.doesNotMatch(error.message, /private-sentinel/);
          return true;
        }
      );

      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: { ...fixture.env, PARKBENCH_SMOKE_SKIP_DISK_IO: "1" },
          runCommand: fixture.runCommand,
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: fixture.browser
        }),
        /licensed_disk_io_opt_out_forbidden/
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("fails when Playwright Chromium or the deployed web UI is unavailable", async () => {
    const gate = await loadGate();
    const fixture = licensedFixture();
    try {
      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: fixture.env,
          runCommand: fixture.runCommand,
          fetchImpl: fixture.fetchImpl,
          browserExecutablePath: path.join(fixture.temporaryRoot, "missing-chromium")
        }),
        /licensed_playwright_browser_unavailable/
      );
      await assert.rejects(
        gate.licensedUiPreflight({
          root,
          env: fixture.env,
          runCommand: fixture.runCommand,
          fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
          browserExecutablePath: fixture.browser
        }),
        /licensed_ui_unavailable/
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("runs both OpenEdge and platform preflights and returns a redacted success summary", async () => {
    const gate = await loadGate();
    const fixture = licensedFixture();
    const commands: string[][] = [];
    try {
      const result = await gate.licensedUiPreflight({
        root,
        env: fixture.env,
        runCommand: async (command: string, args: string[]) => {
          commands.push([command, ...args]);
          return fixture.runCommand(command, args);
        },
        fetchImpl: fixture.fetchImpl,
        browserExecutablePath: fixture.browser
      });
      assert.equal(result.valid, true);
      assert.deepEqual(result.openEdge, "passed");
      assert.deepEqual(result.platform, "passed");
      assert(commands.some((entry) => entry.includes("openedge:preflight")));
      assert(
        commands.some(
          (entry) =>
            entry.includes("--scenario") &&
            entry.includes("examples/scenarios/parkbench-bank-mix.json")
        )
      );
      assert.doesNotMatch(JSON.stringify(result), /progress\.cfg|seed\.json|sha256:/);
    } finally {
      fixture.cleanup();
    }
  });

  it("exits nonzero when invoked with an empty private environment", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-empty-licensed-env-"));
    const envFile = path.join(temporaryRoot, "empty.env");
    fs.writeFileSync(envFile, "");
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/openedge/licensed-ui-preflight.mjs", "--env-file", envFile],
        { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } }
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /licensed_ui_setting_required/);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /progress\.cfg|seed\.json|secret/i);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
