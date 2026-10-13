export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly fields: Array<{ path: string; code: string; message?: string }> = []
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {})
    }
  });
  const body = await response.json();
  if (!response.ok)
    throw new ApiError(
      body.error?.message ?? "request_failed",
      body.error?.code,
      body.error?.fields ?? []
    );
  return body;
}

export function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `parkbench-${Date.now()}-${Math.random()}`;
}
