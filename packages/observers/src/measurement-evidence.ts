import type { ObservationEvidence } from "../../contracts/src/measurement-diagnostics";
import type { ObserverContext } from "./adapter";
export type EvidenceInput = Omit<
  ObservationEvidence,
  | "contractVersion"
  | "eventId"
  | "runId"
  | "experimentId"
  | "diagnosticAttemptId"
  | "component"
  | "componentInstanceId"
  | "sequence"
>;
/** An evidence failure never escapes into measurement acquisition. */
export function emitMeasurementEvidence(
  context: Pick<ObserverContext, "measurementEvidence"> & Partial<Pick<ObserverContext, "phase">>,
  stage: ObservationEvidence["stage"],
  outcome: ObservationEvidence["outcome"],
  fields: Partial<EvidenceInput> = {}
): string | undefined {
  if (!context.measurementEvidence) return;
  try {
    return (
      context.measurementEvidence.record({
        stage,
        outcome,
        scheduledAtMs: context.measurementEvidence.scheduledAtMs ?? null,
        startedAtMs: null,
        finishedAtMs: null,
        sourceCapturedAtMs: null,
        availableAtMs: null,
        timestampOrigin: "UNKNOWN",
        durationMs: 0,
        queueWaitMs: 0,
        bodyReadMs: 0,
        callerRole: "CONTROLLER",
        ...(context.phase ? { phase: context.phase } : {}),
        ...(context.measurementEvidence.parentEventId
          ? { parentEventId: context.measurementEvidence.parentEventId }
          : {}),
        ...(context.measurementEvidence.slotId
          ? { slotId: context.measurementEvidence.slotId }
          : {}),
        ...(context.measurementEvidence.controllerAttempt
          ? { controllerAttempt: context.measurementEvidence.controllerAttempt }
          : {}),
        ...fields
      }) || undefined
    );
  } catch {
    return undefined;
  }
}
