import fs from "node:fs";

export class PasManagementClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3000,
    private readonly credentialRef?: string,
    private readonly instanceName = process.env.PARKBENCH_PAS_INSTANCE ?? "oepas1",
    private readonly webAppName = process.env.PARKBENCH_PAS_WEBAPP_NAME ?? "parkbench"
  ) {}
  async health(): Promise<boolean> {
    try {
      const response = await requestWithRetry(
        `${this.baseUrl}/health`,
        this.timeoutMs,
        this.credentialRef
      );
      return response.ok;
    } catch {
      return false;
    }
  }
  async getMetrics(): Promise<Record<string, number>> {
    const response = await requestWithRetry(
      `${this.baseUrl}/oemanager/applications/${encodeURIComponent(this.instanceName)}/webapps/${encodeURIComponent(this.webAppName)}/transports/web/metrics`,
      this.timeoutMs,
      this.credentialRef
    );
    if (!response.ok) throw new Error(`pas_management_failed:${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    const values =
      payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
        ? (payload.result as Record<string, unknown>)
        : payload;
    return Object.fromEntries(
      Object.entries(values).flatMap(([name, value]) => {
        const numeric =
          typeof value === "number"
            ? value
            : typeof value === "string" && value.trim() !== ""
              ? Number(value)
              : Number.NaN;
        return Number.isFinite(numeric) ? [[name, numeric]] : [];
      })
    );
  }
}

export function resolveCredentialToken(
  credentialRef: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!credentialRef) return undefined;
  if (!credentialRef.startsWith("credential:")) throw new Error("credential_reference_required");
  const identifier = credentialRef.slice("credential:".length);
  const key = identifier.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const token = env[`PARKBENCH_CREDENTIAL_${key}`];
  const file = env[`PARKBENCH_CREDENTIAL_FILE_${key}`];
  if (token) return token;
  if (file) return fs.readFileSync(file, "utf8").trim();
  throw new Error("credential_value_unavailable");
}

export async function requestWithRetry(
  url: string,
  timeoutMs: number,
  credentialRef?: string,
  attempts = 3,
  requestInit: RequestInit = {}
): Promise<Response> {
  let lastError: unknown;
  const token = resolveCredentialToken(credentialRef);
  const headers = token
    ? {
        authorization: /^(?:Basic|Bearer)\s/i.test(token) ? token : `Bearer ${token}`
      }
    : undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...requestInit,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...headers, ...requestInit.headers }
      });
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`http_${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  throw lastError;
}
