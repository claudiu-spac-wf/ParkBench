import { diagnostic, ProbeDiagnostic } from "./diagnostics";
export async function waitForDatabase(
  readiness: () => Promise<boolean>,
  timeoutMs = 60000,
  intervalMs = 100
): Promise<ProbeDiagnostic | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await readiness()) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return diagnostic(
    "db",
    "PROVISIONING",
    "database_readiness_timeout",
    `Database did not become ready within ${timeoutMs}ms`
  );
}
