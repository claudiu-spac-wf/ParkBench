import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DatabaseIopsError,
  DATABASE_IOPS_LIMITS,
  DATABASE_IOPS_UNLIMITED_RATE,
  IopsRules,
  validateIopsRules
} from "../../contracts/src/database-iops";
const execAsync = promisify(execFile);
/** Small local-only transport. Never exposes raw daemon errors/inspect bodies to logs. */
export class EngineApi {
  apiVersion = "";
  engineVersion = "";
  daemonId = "";
  constructor(readonly socketPath: string) {
    if (!socketPath.startsWith("/") || socketPath.includes("\0"))
      throw new DatabaseIopsError(
        "database_iops_unsupported",
        undefined,
        "local_unix_socket_required"
      );
  }
  async initialize(deadline = Date.now() + 10000) {
    const version = await this.request("GET", "/version", undefined, deadline);
    if (!/^1\.\d+$/.test(version.ApiVersion))
      throw new DatabaseIopsError("database_iops_unsupported", undefined, "engine_api_unknown");
    this.apiVersion = `1.${Math.min(55, Number(version.ApiVersion.split(".")[1]))}`;
    this.engineVersion = String(version.Version ?? "");
    const info = await this.request("GET", this.versioned("/info"), undefined, deadline);
    if (typeof info.ID !== "string" || !info.ID)
      throw new DatabaseIopsError(
        "database_iops_unsupported",
        undefined,
        "daemon_identity_missing"
      );
    this.daemonId = info.ID;
    return this;
  }
  requireFinite() {
    if (
      !/^1\.\d+$/.test(this.apiVersion) ||
      Number(this.apiVersion.split(".")[1]) < 55 ||
      !this.daemonId
    )
      throw new DatabaseIopsError(
        "database_iops_unsupported",
        undefined,
        "requires_engine_api_1_55"
      );
  }
  versioned(p: string) {
    return `/v${this.apiVersion}${p}`;
  }
  async inspect(id: string, deadline = Date.now() + 10000) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "full_container_id_required"
      );
    return this.request("GET", this.versioned(`/containers/${id}/json`), undefined, deadline);
  }
  async updateIops(id: string, rules: IopsRules, deadline = Date.now() + 10000) {
    this.requireFinite();
    validateIopsRules(rules);
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new DatabaseIopsError(
        "database_iops_apply_failed",
        undefined,
        "full_container_id_required"
      );
    const result = await this.request(
      "POST",
      this.versioned(`/containers/${id}/update`),
      { BlkioDeviceReadIOps: rules.read, BlkioDeviceWriteIOps: rules.write },
      deadline
    );
    if (result.Warnings != null && (!Array.isArray(result.Warnings) || result.Warnings.length))
      throw new DatabaseIopsError("database_iops_apply_failed", undefined, "engine_update_warning");
  }
  async request(
    method: string,
    p: string,
    body?: unknown,
    deadline = Date.now() + 10000,
    raw = false
  ): Promise<any> {
    const timeout = Math.floor(deadline - Date.now());
    if (timeout <= 0)
      throw new DatabaseIopsError(
        method === "POST" ? "database_iops_apply_failed" : "database_iops_unconfirmed",
        undefined,
        "deadline"
      );
    const payload =
      body === undefined
        ? undefined
        : JSON.stringify(body, (key, value) =>
            key === "Rate" && value === DATABASE_IOPS_UNLIMITED_RATE
              ? (JSON as any).rawJSON(DATABASE_IOPS_UNLIMITED_RATE)
              : value
          );
    if (payload && Buffer.byteLength(payload) > DATABASE_IOPS_LIMITS.replyBytes)
      throw new DatabaseIopsError("database_iops_apply_failed", undefined, "request_capacity");
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (!settled) {
          settled = true;
          reject(
            new DatabaseIopsError(
              method === "POST" ? "database_iops_apply_failed" : "database_iops_unconfirmed",
              undefined,
              reason
            )
          );
        }
      };
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: p,
          method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}
        },
        (res) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > DATABASE_IOPS_LIMITS.replyBytes) {
              fail("response_capacity");
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => fail("response_unavailable"));
          res.on("end", () => {
            if (settled) return;
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300)
              return fail(`engine_status_${res.statusCode ?? 0}`);
            try {
              const value = raw
                ? Buffer.concat(chunks)
                : bytes
                  ? JSON.parse(
                      Buffer.concat(chunks).toString("utf8"),
                      (key, value, context?: any) =>
                        key === "Rate" && context?.source === DATABASE_IOPS_UNLIMITED_RATE
                          ? DATABASE_IOPS_UNLIMITED_RATE
                          : value
                    )
                  : {};
              settled = true;
              resolve(value);
            } catch {
              fail("response_invalid");
            }
          });
        }
      );
      const timer = setTimeout(() => {
        fail("deadline");
        req.destroy();
      }, timeout);
      req.on("error", () => fail("engine_unavailable"));
      req.on("close", () => clearTimeout(timer));
      if (payload) req.write(payload);
      req.end();
    });
  }
  /** Execute the fixed owned inspection program without spawning a Docker CLI per tick. */
  async execReadonly(id: string, command: string[], deadline: number): Promise<string> {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !Array.isArray(command) ||
      command.some((s) => typeof s !== "string" || s.includes("\0"))
    )
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "readonly_exec_identity_invalid"
      );
    const created = await this.request(
      "POST",
      this.versioned(`/containers/${id}/exec`),
      { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command },
      deadline
    );
    if (!/^[a-f0-9]{64}$/.test(created.Id))
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "readonly_exec_identity_invalid"
      );
    const data: Buffer = await this.request(
      "POST",
      this.versioned(`/exec/${created.Id}/start`),
      { Detach: false, Tty: false },
      deadline,
      true
    );
    const stdout: Buffer[] = [];
    let offset = 0,
      stderr = false;
    while (offset < data.length) {
      if (
        data.length - offset < 8 ||
        ![1, 2].includes(data[offset]) ||
        data[offset + 1] ||
        data[offset + 2] ||
        data[offset + 3]
      )
        throw new DatabaseIopsError(
          "database_iops_unconfirmed",
          undefined,
          "readonly_exec_stream_invalid"
        );
      const length = data.readUInt32BE(offset + 4);
      if (length > data.length - offset - 8)
        throw new DatabaseIopsError(
          "database_iops_unconfirmed",
          undefined,
          "readonly_exec_stream_invalid"
        );
      if (data[offset] === 1) stdout.push(data.subarray(offset + 8, offset + 8 + length));
      else if (length) stderr = true;
      offset += 8 + length;
    }
    const state = await this.request(
      "GET",
      this.versioned(`/exec/${created.Id}/json`),
      undefined,
      deadline
    );
    if (state.Running || state.ExitCode !== 0 || stderr) {
      if (state.ExitCode === 29)
        throw new DatabaseIopsError(
          "database_iops_unsupported",
          undefined,
          "stacked_or_partitioned_backing_requires_verified_adapter"
        );
      throw new DatabaseIopsError(
        "database_iops_unconfirmed",
        undefined,
        "owned_readonly_probe_unavailable"
      );
    }
    return Buffer.concat(stdout).toString("utf8");
  }
  static async forDocker(docker = "docker", env = process.env, deadline = Date.now() + 10000) {
    let host: string;
    const options = {
      encoding: "utf8" as const,
      timeout: Math.max(1, Math.min(10000, deadline - Date.now())),
      maxBuffer: 65536,
      env
    };
    try {
      if (env.DOCKER_CONTEXT) {
        const r = await execAsync(
          docker,
          ["context", "inspect", env.DOCKER_CONTEXT, "--format", "{{.Endpoints.docker.Host}}"],
          options
        );
        host = r.stdout.trim();
      } else if (env.DOCKER_HOST) host = env.DOCKER_HOST;
      else {
        const r = await execAsync(
          docker,
          ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
          options
        );
        host = r.stdout.trim();
      }
      if (!host.startsWith("unix:///")) throw Error();
      const api = await new EngineApi(decodeURIComponent(host.slice(7))).initialize(deadline);
      const r = await execAsync(docker, ["info", "--format", "{{.ID}}"], options);
      if (r.stdout.trim() !== api.daemonId) throw Error();
      return api;
    } catch {
      throw new DatabaseIopsError(
        "database_iops_unsupported",
        undefined,
        "compose_engine_identity_or_socket_unavailable"
      );
    }
  }
}
