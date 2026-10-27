import fs from "node:fs";
import path from "node:path";
import { ReportArtifacts } from "./artifacts";
export function reportDownload(storage: ReportArtifacts, reportId: string, artifactId: string) {
  const report = storage.repository.get(reportId);
  if (!report) throw new Error("report_not_found");
  const artifact = report.artifacts.find((a) => a.id === artifactId);
  if (!artifact) throw new Error("report_artifact_not_found");
  const root = fs.realpathSync(storage.root),
    expected = path.join(root, reportId),
    candidate = path.resolve(root, artifact.relativePath);
  if (!candidate.startsWith(expected + path.sep)) throw new Error("report_artifact_invalid");
  let fd: number;
  try {
    if (
      fs.lstatSync(expected).isSymbolicLink() ||
      fs.realpathSync(expected) !== expected ||
      fs.lstatSync(candidate).isSymbolicLink() ||
      fs.realpathSync(candidate) !== candidate
    )
      throw new Error("report_artifact_invalid");
    fd = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    if (!fs.fstatSync(fd).isFile()) {
      fs.closeSync(fd);
      throw new Error("report_artifact_invalid");
    }
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes((e as any).code))
      throw new Error("report_artifact_unavailable");
    throw new Error("report_artifact_invalid");
  }
  return {
    artifact,
    stream: fs.createReadStream(candidate, { fd, autoClose: true }),
    filename:
      `${report.seedSnapshot.name}-${report.type}-${report.id}-${artifact.filename}`.replace(
        /[^a-zA-Z0-9_.-]/g,
        "_"
      )
  };
}
