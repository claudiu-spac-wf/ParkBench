import "./stage-inputs.mjs";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadContracts } from "../lib/contracts.mjs";

const SIGNATURE = /DEFINE\s+INPUT\s+PARAMETER\s+SingleParam\s+AS\s+LONGCHAR\b/i;

export function discoverWorkloads(workloadRoot, { allowEmpty = false, compile = true } = {}) {
  if (!fs.existsSync(workloadRoot)) {
    if (allowEmpty) return [];
    throw new Error(`workload_root_missing:${path.basename(workloadRoot)}`);
  }
  const batch = compile && supportsBatch(process.env.PARKBENCH_OPENEDGE_COMPILER);
  const procedures = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".p")) {
        const source = fs.readFileSync(full, "utf8");
        if (
          !SIGNATURE.test(source) ||
          (source.match(/DEFINE\s+INPUT\s+PARAMETER\b/gi) ?? []).length !== 1
        )
          throw new Error(`workload_signature_invalid:${entry.name}`);
        const relative = path.relative(workloadRoot, full).split(path.sep).join("/");
        const procName = `Workloads/${relative}`;
        const compilation =
          compile && !batch
            ? compileProcedure(full)
            : { compiled: fs.existsSync(full.slice(0, -2) + ".r") };
        const workloadContract = readWorkloadContract(full, procName);
        procedures.push({
          procName,
          sourcePath: full,
          compiled: compilation.compiled,
          signature: "INPUT SingleParam AS LONGCHAR",
          pathStatus: "canonical",
          ...(workloadContract ? { contract: workloadContract } : {})
        });
      }
    }
  };
  visit(workloadRoot);
  if (!allowEmpty && procedures.length === 0) throw new Error("workload_root_empty");
  if (batch && procedures.length) {
    compileSources(procedures.map((procedure) => procedure.sourcePath));
    for (const procedure of procedures) procedure.compiled = true;
  }
  return procedures;
}

function compileProcedure(sourcePath) {
  const compiler = process.env.PARKBENCH_OPENEDGE_COMPILER;
  if (!compiler) return { compiled: false };
  const compiledPath = `${sourcePath.slice(0, -path.extname(sourcePath).length)}.r`;
  fs.rmSync(compiledPath, { force: true });
  try {
    executeCompiler(compiler, sourcePath);
    if (!fs.existsSync(compiledPath) || !fs.statSync(compiledPath).isFile())
      throw new Error("compiled_output_missing");
    return { compiled: true };
  } catch {
    throw new Error(`workload_compile_failed:${path.basename(sourcePath)}`);
  }
}

function executeCompiler(compiler, sourcePath) {
  executeCompilerArguments(compiler, [sourcePath]);
}

function executeCompilerArguments(compiler, args) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(compiler)) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", compiler, ...args], {
      stdio: "pipe"
    });
    return;
  }
  execFileSync(compiler, args, { stdio: "pipe" });
}

function supportsBatch(compiler) {
  if (!compiler) return false;
  const file = path.resolve(compiler);
  return ["compile-with-db.mjs", "compile-with-db.cmd"].some(
    (name) => file === fileURLToPath(new URL(name, import.meta.url))
  );
}

export function compileSources(sourcePaths, compiler = process.env.PARKBENCH_OPENEDGE_COMPILER) {
  if (!sourcePaths.length) return;
  if (!compiler) throw new Error("workload_compiler_required");
  const outputs = sourcePaths.map((file) => `${file.slice(0, -path.extname(file).length)}.r`);
  for (const file of outputs) fs.rmSync(file, { force: true });
  try {
    if (supportsBatch(compiler)) executeCompilerArguments(compiler, ["--batch", ...sourcePaths]);
    else for (const file of sourcePaths) executeCompiler(compiler, file);
    for (const file of outputs)
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new Error("compiled_output_missing");
  } catch (error) {
    for (const file of outputs) fs.rmSync(file, { force: true });
    throw new Error("workload_batch_compile_failed", { cause: error });
  }
}

export function prepareRunnerArchive({
  workloadRoot,
  outputRoot,
  stage,
  handlerPath,
  servicePath,
  runtimePath,
  pasoeBaseImage,
  stageRoot: configuredStageRoot,
  allowEmpty = false,
  compileHandler = true,
  compileWorkloads = true,
  archiveContents
}) {
  const batch =
    supportsBatch(process.env.PARKBENCH_OPENEDGE_COMPILER) &&
    (compileWorkloads || (handlerPath && compileHandler));
  const procedures = discoverWorkloads(workloadRoot, {
    allowEmpty,
    compile: compileWorkloads && !batch
  });
  if (batch) {
    compileSources([
      ...(compileWorkloads ? procedures.map((procedure) => procedure.sourcePath) : []),
      ...(handlerPath && compileHandler ? [handlerPath] : [])
    ]);
    if (compileWorkloads) for (const procedure of procedures) procedure.compiled = true;
  }
  const stageRoot = path.resolve(configuredStageRoot ?? path.join(outputRoot, "staging", stage));
  const appRoot = path.join(stageRoot, "app-root");
  const appOpenEdgeRoot = path.join(appRoot, "openedge");
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(appOpenEdgeRoot, "Workloads"), { recursive: true });
  fs.writeFileSync(path.join(appOpenEdgeRoot, "Workloads", ".keep"), "");
  const handlerCompilation =
    handlerPath && compileHandler
      ? batch
        ? { compiled: true }
        : compileProcedure(handlerPath)
      : { compiled: false };
  const handlerCompiled = handlerCompilation.compiled;
  if (handlerPath) {
    fs.copyFileSync(handlerPath, path.join(appOpenEdgeRoot, "ParkBenchWorkHandler.cls"));
    const compiledHandler = `${handlerPath.slice(0, -4)}.r`;
    if (fs.existsSync(compiledHandler))
      fs.copyFileSync(compiledHandler, path.join(appOpenEdgeRoot, "ParkBenchWorkHandler.r"));
  }
  if (servicePath) fs.copyFileSync(servicePath, path.join(appOpenEdgeRoot, "service.json"));
  if (runtimePath) fs.copyFileSync(runtimePath, path.join(appRoot, "runtime.properties"));
  writeApplicationConfig(appRoot);
  writeRuntimeProperties(appRoot);
  for (const procedure of procedures) {
    const destination = path.join(appOpenEdgeRoot, procedure.procName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(procedure.sourcePath, destination);
    const compiled = path.join(
      path.dirname(procedure.sourcePath),
      `${path.basename(procedure.sourcePath, ".p")}.r`
    );
    if (fs.existsSync(compiled)) fs.copyFileSync(compiled, `${destination.slice(0, -2)}.r`);
    if (procedure.contract) {
      const contractDestination = path.join(appOpenEdgeRoot, procedure.contract.path);
      fs.mkdirSync(path.dirname(contractDestination), { recursive: true });
      fs.copyFileSync(procedure.contract.sourcePath, contractDestination);
    }
  }
  if (archiveContents) {
    const manifestPath = path.join(appRoot, "parkbench", "archive-contents.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(archiveContents, null, 2));
  }
  if (pasoeBaseImage)
    copyPasoeWebApp(pasoeBaseImage, path.join(appRoot, "webapps", "parkbench.war"));
  const appArchive = path.join(stageRoot, "parkbench.zip");
  fs.rmSync(appArchive, { force: true });
  writeZipArchive(appRoot, appArchive);
  const instanceRoot = path.join(stageRoot, "instance-root");
  fs.rmSync(instanceRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(instanceRoot, "ablapps"), { recursive: true });
  fs.copyFileSync(appArchive, path.join(instanceRoot, "ablapps/parkbench.zip"));
  const archive = path.join(
    outputRoot,
    stage === "final" ? "archives" : "stages/generic/archives",
    "oepas1.zip"
  );
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.rmSync(archive, { force: true });
  writeZipArchive(instanceRoot, archive);
  const relative = path.relative(outputRoot, archive);
  return {
    archive,
    artifact: { path: relative, kind: "pasoe-runner-archive" },
    procedures,
    handlerCompiled
  };
}

/** A workload's contract is the sibling `<basename>.contract.json` file, when present. */
function readWorkloadContract(sourcePath, procName) {
  const contractPath = `${sourcePath.slice(0, -2)}.contract.json`;
  if (!fs.existsSync(contractPath)) return undefined;
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch {
    throw new Error(`workload_contract_invalid:json:${path.basename(contractPath)}`);
  }
  loadContracts().validateWorkloadContract(contract, procName);
  return {
    path: `${procName.slice(0, -2)}.contract.json`,
    sourcePath: contractPath
  };
}

function writeApplicationConfig(appRoot) {
  const configRoot = path.join(appRoot, "conf");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, "MANIFEST.MF"),
    "Manifest-Version: 1.0\nABL-Application-Name: parkbench\nABL-Application-Version: 1.0.0\n"
  );
  // The PAS deploy replaces this -db line from runtime.properties <app>.DB.CONNECTION.PARAMS,
  // which the PAS entrypoint sets from the run's PARKBENCH_PAS_DB_CONNECTION.
  fs.writeFileSync(path.join(configRoot, "startup.pf"), "-db parkbench -H database -S 20931\n");
}

function writeRuntimeProperties(appRoot) {
  const mergeRoot = path.join(appRoot, "tlr");
  fs.mkdirSync(mergeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(mergeRoot, "openedge.properties.merge"),
    `[parkbench]\nwebApps=parkbench\n\n[AppServer.SessMgr.oepas1]\nagentStartupParam=-pf \${catalina.base}/ablapps/parkbench/conf/startup.pf\n\n[AppServer.Agent.oepas1]\nPROPATH=\${CATALINA_BASE}/ablapps/parkbench/openedge,\${CATALINA_BASE}/webapps/parkbench/WEB-INF/openedge,\${CATALINA_BASE}/ablapps/oepas1/openedge,\${CATALINA_BASE}/openedge,\${DLC}/tty,\${DLC}/tty/netlib/OpenEdge.Net.apl\n\n[oepas1.parkbench.WEB]\nadapterEnabled=1\ncollectMetrics=3\ndefaultHandler=OpenEdge.Web.DefaultWebHandler\nhandler1=ParkBenchWorkHandler: /work\nhandler2=ParkBenchWorkHandler: /health\nhandler3=ParkBenchWorkHandler: /metrics\n`
  );
}

function copyPasoeWebApp(pasoeBaseImage, destination) {
  let container;
  try {
    container = execFileSync("docker", ["create", "--pull=never", pasoeBaseImage], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync(
      "docker",
      ["cp", `${container}:/psc/dlc/servers/pasoe/extras/oeabl.war`, destination],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch {
    throw new Error("pasoe_webapp_template_unavailable");
  } finally {
    if (container) execFileSync("docker", ["rm", container], { stdio: "ignore" });
  }
}

function writeZipArchive(root, archive) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile())
        entries.push({
          name: path.relative(root, full).split(path.sep).join("/"),
          data: fs.readFileSync(full)
        });
    }
  };
  visit(root);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(archive, Buffer.concat([...localParts, ...centralParts, end]));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
