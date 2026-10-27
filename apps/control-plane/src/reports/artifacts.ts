import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ReportRepository } from "./repository";
import {
  ReportArtifact,
  DatasetKind
} from "../../../../packages/contracts/src/database-analysis-report";
export class ReportArtifacts {
  readonly root: string;
  constructor(
    artifactRoot: string,
    readonly repository: ReportRepository
  ) {
    this.root = path.resolve(artifactRoot, "reports");
    fs.mkdirSync(this.root, { recursive: true });
  }
  directory(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("report_artifact_invalid");
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir)
      throw new Error("report_artifact_invalid");
    return dir;
  }
  execution(id: string) {
    const dir = this.directory(id);
    for (const sub of ["raw", "execution", "scratch"]) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
      fs.chmodSync(path.join(dir, sub), 0o777);
    }
    return dir;
  }
  publish(
    reportId: string,
    filename: string,
    data: string,
    kind: ReportArtifact["kind"],
    complete: boolean,
    datasetKind?: DatasetKind
  ) {
    const dir = this.directory(reportId);
    const staging = path.join(dir, randomUUID() + ".tmp");
    const fd = fs.openSync(staging, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return this.publishStaged(reportId, staging, filename, kind, complete, datasetKind);
  }
  publishStaged(
    reportId: string,
    staging: string,
    filename: string,
    kind: ReportArtifact["kind"],
    complete: boolean,
    datasetKind?: DatasetKind
  ) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw new Error("report_artifact_invalid");
    const dir = this.directory(reportId),
      target = path.join(dir, filename);
    if (fs.existsSync(target)) throw new Error("report_artifact_exists");
    fs.renameSync(staging, target);
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const artifact: ReportArtifact = {
      id: randomUUID(),
      reportId,
      kind,
      datasetKind,
      filename,
      relativePath: path.relative(this.root, target),
      mediaType:
        kind === "CSV"
          ? "text/csv; charset=utf-8"
          : kind === "MANIFEST"
            ? "application/json"
            : "text/plain; charset=utf-8",
      byteLength: fs.statSync(target, { bigint: true }).size.toString(),
      complete
    };
    this.repository.artifact(artifact);
    return artifact;
  }
}
