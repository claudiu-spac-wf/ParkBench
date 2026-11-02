export const NATIVE_FAILURE_CODES = [
  "native_process_deadline",
  "native_process_exit",
  "native_process_signal",
  "native_process_unavailable",
  "native_process_output_limit",
  "native_connection_capacity",
  "native_process_unknown",
  "native_output_invalid"
] as const;
export interface NativeProcessFailure {
  code: (typeof NATIVE_FAILURE_CODES)[number];
  exitCode: number | null;
  signal: "SIGKILL" | "SIGTERM" | "OTHER" | null;
  outputState: "NONE" | "INVALID" | "VALID";
  outputBytes: number;
  sourceCapturedAtMs: number | null;
}

/** Inspect bounded child output transiently; retain no output, argv or error text. */
export function nativeProcessFailure(
  error: unknown,
  parse: (text: string) => { collectedAt: string }
): NativeProcessFailure {
  const e = (error ?? {}) as {
    stdout?: unknown;
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
  };
  const stdout = typeof e.stdout === "string" ? e.stdout : "";
  const outputBytes = Buffer.byteLength(stdout);
  let outputState: NativeProcessFailure["outputState"] = outputBytes ? "INVALID" : "NONE";
  let sourceCapturedAtMs: number | null = null;
  if (outputBytes && outputBytes <= 8 * 1024 * 1024) {
    try {
      const parsed = parse(stdout);
      sourceCapturedAtMs = Date.parse(parsed.collectedAt);
      if (!Number.isFinite(sourceCapturedAtMs)) throw new Error("unknown_capture_time");
      outputState = "VALID";
    } catch {
      sourceCapturedAtMs = null;
    }
  }
  const code: NativeProcessFailure["code"] =
    e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "native_process_output_limit"
      : /\((?:748|1154)\)/.test(stdout) && /\(19489\)/.test(stdout)
        ? "native_connection_capacity"
        : e.killed === true && e.signal === "SIGKILL"
          ? "native_process_deadline"
          : typeof e.code === "number"
            ? "native_process_exit"
            : ["ENOENT", "EACCES", "EPERM"].includes(String(e.code))
              ? "native_process_unavailable"
              : typeof e.signal === "string"
                ? "native_process_signal"
                : "native_process_unknown";
  return {
    code,
    exitCode: Number.isSafeInteger(e.code) ? (e.code as number) : null,
    signal:
      e.signal === "SIGKILL" || e.signal === "SIGTERM"
        ? e.signal
        : typeof e.signal === "string"
          ? "OTHER"
          : null,
    outputState,
    outputBytes,
    sourceCapturedAtMs
  };
}
