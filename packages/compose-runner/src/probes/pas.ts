import { diagnostic, ProbeDiagnostic } from "./diagnostics";
export async function waitForPasReplicas(
  readiness: (replica: number) => Promise<boolean>,
  replicas: number,
  timeoutMs = 60000
): Promise<ProbeDiagnostic | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await Promise.all(Array.from({ length: replicas }, (_, i) => readiness(i + 1)));
    if (ready.every(Boolean)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return diagnostic(
    "pas",
    "DB_READY",
    "pas_readiness_timeout",
    `${replicas} PAS replicas did not become ready within ${timeoutMs}ms`
  );
}
