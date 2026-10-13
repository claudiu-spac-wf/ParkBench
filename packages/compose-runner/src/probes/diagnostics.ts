export interface ProbeDiagnostic {
  component: string;
  phase: string;
  code: string;
  message: string;
  capturedAt: string;
}
export function diagnostic(
  component: string,
  phase: string,
  code: string,
  message: string
): ProbeDiagnostic {
  return { component, phase, code, message, capturedAt: new Date().toISOString() };
}
