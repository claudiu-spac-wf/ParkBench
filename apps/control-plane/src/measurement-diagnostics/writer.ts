// The shared writer uses only contracts and Node primitives, so owned observer
// processes can use exactly the same bounds without depending on control-plane.
export {
  DiagnosticBudgetStore,
  MeasurementDiagnosticsWriter
} from "../../../../packages/observers/src/measurement-diagnostics-writer";
export type { DiagnosticsWriterOptions } from "../../../../packages/observers/src/measurement-diagnostics-writer";
