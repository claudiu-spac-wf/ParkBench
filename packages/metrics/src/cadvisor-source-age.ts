/** cAdvisor v0.55.1 applies jitter(base, 1.0) even when dynamic
 * housekeeping is disabled: scheduled source age can reach twice the base.
 * https://github.com/google/cadvisor/blob/v0.55.1/manager/container.go
 * This supplies the existing edge model; it does not change interior gaps. */
export function cadvisorSourceAgeSeconds(housekeepingSeconds: number): number {
  if (!Number.isFinite(housekeepingSeconds) || housekeepingSeconds < 0)
    throw new Error("source_acquisition_lag_invalid");
  return 2 * housekeepingSeconds;
}
