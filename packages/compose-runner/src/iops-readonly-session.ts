import http from "node:http";
import type { Socket } from "node:net";
import type { EngineApi } from "./engine-api";
import { DatabaseIopsError, DATABASE_IOPS_LIMITS } from "../../contracts/src/database-iops";

/** One idle, read-only exec. A token requests one fresh probe; no background polling. */
export class IopsReadonlySession {
  private frames = Buffer.alloc(0);
  private sequence = 0;
  private closed = false;
  private pending?: {
    token: string;
    chunks: Buffer[];
    bytes: number;
    timer: ReturnType<typeof setTimeout>;
    resolve(value: string): void;
    reject(error: Error): void;
  };
  constructor(
    readonly socket: Socket,
    readonly execId: string,
    head = Buffer.alloc(0)
  ) {
    socket.on("data", (data) => this.receive(data));
    socket.on("error", () => this.fail("readonly_worker_unavailable"));
    socket.on("close", () => this.fail("readonly_worker_closed"));
    if (head.length) this.receive(head);
  }
  private fail(reason: string) {
    const pending = this.pending;
    this.pending = undefined;
    this.closed = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new DatabaseIopsError("database_iops_unconfirmed", undefined, reason));
    }
    this.socket.destroy();
  }
  private receive(data: Buffer) {
    if (this.closed) return;
    if (data.length + this.frames.length > DATABASE_IOPS_LIMITS.replyBytes)
      return this.fail("readonly_worker_capacity");
    this.frames = Buffer.concat([this.frames, data]);
    while (this.frames.length >= 8) {
      const stream = this.frames[0],
        length = this.frames.readUInt32BE(4);
      if (
        ![1, 2].includes(stream) ||
        this.frames[1] ||
        this.frames[2] ||
        this.frames[3] ||
        length > DATABASE_IOPS_LIMITS.replyBytes
      )
        return this.fail("readonly_worker_stream_invalid");
      if (this.frames.length < 8 + length) return;
      const payload = this.frames.subarray(8, 8 + length);
      this.frames = this.frames.subarray(8 + length);
      if (!length) continue;
      if (stream === 2 || !this.pending) return this.fail("readonly_worker_unexpected_output");
      const pending = this.pending;
      pending.bytes += length;
      if (pending.bytes > DATABASE_IOPS_LIMITS.replyBytes)
        return this.fail("readonly_worker_capacity");
      pending.chunks.push(payload);
      const text = Buffer.concat(pending.chunks).toString("utf8");
      const marker = `\nIOPS_END\t${pending.token}\t`;
      const index = text.lastIndexOf(marker);
      if (index < 0 || !text.endsWith("\n")) continue;
      const status = text.slice(index + marker.length, -1);
      if (!/^\d+$/.test(status)) return this.fail("readonly_worker_receipt_invalid");
      if (status !== "0")
        return this.fail(
          status === "29"
            ? "stacked_or_partitioned_backing_requires_verified_adapter"
            : "owned_readonly_probe_unavailable"
        );
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve(text.slice(0, index));
    }
  }
  request(deadline: number): Promise<string> {
    if (this.closed || this.pending || deadline <= Date.now())
      return Promise.reject(
        new DatabaseIopsError(
          "database_iops_unconfirmed",
          undefined,
          "readonly_worker_unavailable_or_busy"
        )
      );
    return new Promise((resolve, reject) => {
      const token = String(++this.sequence);
      const timer = setTimeout(
        () => this.fail("readonly_worker_deadline"),
        Math.max(1, deadline - Date.now())
      );
      this.pending = { token, chunks: [], bytes: 0, timer, resolve, reject };
      this.socket.write(token + "\n");
    });
  }
  close() {
    const pending = this.pending;
    this.pending = undefined;
    this.closed = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new DatabaseIopsError("database_iops_unconfirmed", undefined, "readonly_worker_closed")
      );
    }
    // EOF releases the worker's blocking read; never leave an idle host-reader process.
    this.socket.end();
    this.socket.unref();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

export async function openIopsReadonlySession(
  api: EngineApi,
  readerId: string,
  command: string[],
  deadline: number
): Promise<IopsReadonlySession> {
  if (!/^[a-f0-9]{64}$/.test(readerId))
    throw new DatabaseIopsError("database_iops_unconfirmed", undefined, "full_reader_id_required");
  const created = await api.request(
    "POST",
    api.versioned(`/containers/${readerId}/exec`),
    { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command },
    deadline
  );
  if (!/^[a-f0-9]{64}$/.test(created.Id))
    throw new DatabaseIopsError(
      "database_iops_unconfirmed",
      undefined,
      "readonly_worker_identity_invalid"
    );
  const payload = JSON.stringify({ Detach: false, Tty: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(
          new DatabaseIopsError(
            "database_iops_unconfirmed",
            undefined,
            "readonly_worker_start_unavailable"
          )
        );
      }
      req.destroy();
    };
    const req = http.request({
      socketPath: api.socketPath,
      path: api.versioned(`/exec/${created.Id}/start`),
      method: "POST",
      headers: {
        Connection: "Upgrade",
        Upgrade: "tcp",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    });
    const timer = setTimeout(fail, Math.max(0, deadline - Date.now()));
    req.on("upgrade", (response, socket, head) => {
      clearTimeout(timer);
      if (settled || response.statusCode !== 101) {
        socket.destroy();
        return fail();
      }
      settled = true;
      resolve(new IopsReadonlySession(socket, created.Id, head));
    });
    req.on("response", () => {
      clearTimeout(timer);
      fail();
    });
    req.on("error", () => {
      clearTimeout(timer);
      fail();
    });
    req.end(payload);
  });
}
