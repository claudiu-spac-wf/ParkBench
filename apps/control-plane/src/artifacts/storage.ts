import crypto from "node:crypto";
import {
  SummaryRow,
  RunSummaryHeader,
  SummaryStreamValidator
} from "../../../../packages/contracts/src/run-summary";
import { SummaryArtifact, completedSummaryArtifact } from "./manifest";
import fs from "node:fs";
import path from "node:path";
export class ArtifactStorage {
  constructor(public readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }
  safePath(relativePath: string): string {
    const root = path.resolve(this.root);
    const result = path.resolve(root, relativePath);
    if (result !== root && !result.startsWith(`${root}${path.sep}`))
      throw new Error("artifact_path_outside_root");
    return result;
  }
  write(relativePath: string, contents: string | Buffer): { path: string; sizeBytes: number } {
    const target = this.safePath(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return { path: relativePath, sizeBytes: fs.statSync(target).size };
  }
  writeAtomic(
    relativePath: string,
    contents: string | Buffer
  ): { path: string; sizeBytes: number } {
    const target = this.safePath(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + "." + crypto.randomUUID() + ".tmp";
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx");
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, target);
      const dir = fs.openSync(path.dirname(target), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
      return { path: relativePath, sizeBytes: fs.statSync(target).size };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.rmSync(temporary);
    }
  }
  async writeSummaryAttempt(
    header: RunSummaryHeader,
    rows: AsyncIterable<SummaryRow> | Iterable<SummaryRow>,
    token: string,
    signal?: AbortSignal
  ): Promise<SummaryArtifact> {
    for (const part of [header.run.id, header.metricDefinitionsVersion, token])
      if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(part)) throw new Error("summary_path_invalid");
    const relativePath = `${header.run.id}/summaries/${header.metricDefinitionsVersion}/${token}/comparison-summary.v1.json`,
      target = this.safePath(relativePath),
      directory = path.dirname(target);
    const validator = new SummaryStreamValidator(header, header.run.id);
    let handle: fs.promises.FileHandle | undefined;
    try {
      await fs.promises.mkdir(path.dirname(directory), { recursive: true });
      // An attempt directory is allocated once. A second writer cannot overwrite it.
      await fs.promises.mkdir(directory);
      handle = await fs.promises.open(path.join(directory, "comparison-summary.v1.json.tmp"), "wx");
      const prefix = JSON.stringify(header).slice(0, -1) + ',"rows":[';
      await handle.writeFile(prefix);
      let first = true;
      for await (const row of rows) {
        signal?.throwIfAborted();
        validator.append(row);
        await handle.writeFile((first ? "" : ",") + JSON.stringify(row));
        first = false;
      }
      signal?.throwIfAborted();
      validator.finish();
      await handle.writeFile("]}\n");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(path.join(directory, "comparison-summary.v1.json.tmp"), target);
      const dirHandle = await fs.promises.open(directory, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
      return completedSummaryArtifact(
        header,
        token,
        { path: relativePath, sizeBytes: (await fs.promises.stat(target)).size },
        target
      );
    } finally {
      await handle?.close();
      validator.close();
    }
  }
  /** Revalidate a durable current-attempt orphan after process restart without hydrating its rows. */
  async recoverSummaryAttempt(
    runId: string,
    version: string,
    token: string,
    expected: AsyncIterable<SummaryRow>
  ): Promise<{ header: RunSummaryHeader; artifact: SummaryArtifact } | undefined> {
    for (const part of [runId, version, token])
      if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(part)) throw new Error("summary_path_invalid");
    const relativePath = `${runId}/summaries/${version}/${token}/comparison-summary.v1.json`,
      target = this.safePath(relativePath);
    if (!fs.existsSync(target)) return undefined;
    const iterator = expected[Symbol.asyncIterator]();
    let header: RunSummaryHeader | undefined, validator: SummaryStreamValidator | undefined;
    let mode: "header" | "rows" | "footer" = "header",
      buffer = "",
      footer = "",
      depth = 0,
      inString = false,
      escaped = false,
      needValue = true;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const accept = async (text: string) => {
      for (const character of text) {
        if (mode === "footer") {
          footer += character;
          if (footer.length > 16) throw new Error("summary_orphan_invalid");
          continue;
        }
        if (mode === "rows" && depth === 0) {
          if (/\s/.test(character)) continue;
          if (character === "]") {
            if (needValue && buffer === ",") throw new Error("summary_orphan_invalid");
            mode = "footer";
            buffer = "";
            continue;
          }
          if (character === ",") {
            if (needValue) throw new Error("summary_orphan_invalid");
            needValue = true;
            buffer = ",";
            continue;
          }
          if (character !== "{" || !needValue) throw new Error("summary_orphan_invalid");
          buffer = "";
          needValue = false;
        }
        buffer += character;
        if (buffer.length > (mode === "header" ? 2 * 1024 * 1024 : 16 * 1024))
          throw new Error("summary_orphan_budget_exceeded");
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') {
          inString = true;
          continue;
        }
        if (mode === "header" && character === "[" && depth === 1 && buffer.endsWith(',"rows":[')) {
          header = JSON.parse(buffer.slice(0, -',"rows":['.length) + "}");
          if (header!.run.id !== runId || header!.metricDefinitionsVersion !== version)
            throw new Error("summary_orphan_owner_invalid");
          validator = new SummaryStreamValidator(header!, runId);
          mode = "rows";
          depth = 0;
          buffer = "";
          continue;
        }
        if (character === "{" || character === "[") depth++;
        else if (character === "}" || character === "]") depth--;
        if (depth < 0) throw new Error("summary_orphan_invalid");
        if (mode === "rows" && depth === 0) {
          const row = JSON.parse(buffer);
          validator!.append(row);
          const staged = await iterator.next();
          if (staged.done || JSON.stringify(staged.value) !== JSON.stringify(row))
            throw new Error("summary_orphan_staging_mismatch");
          buffer = "";
        }
      }
    };
    try {
      for await (const chunk of fs.createReadStream(target, { highWaterMark: 64 * 1024 }))
        await accept(decoder.decode(chunk as Buffer, { stream: true }));
      await accept(decoder.decode());
      if (
        (mode as string) !== "footer" ||
        footer.trim() !== "}" ||
        !header ||
        !validator ||
        !(await iterator.next()).done
      )
        throw new Error("summary_orphan_invalid");
      validator.finish();
      return {
        header,
        artifact: completedSummaryArtifact(
          header,
          token,
          { path: relativePath, sizeBytes: fs.statSync(target).size },
          target
        )
      };
    } finally {
      validator?.close();
      await iterator.return?.(undefined);
    }
  }
  read(relativePath: string): Buffer {
    return fs.readFileSync(this.safePath(relativePath));
  }
}
