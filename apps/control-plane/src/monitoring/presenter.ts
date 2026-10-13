export function presentRun(run: any, events: any[] = []) {
  return {
    ...run,
    latestEventId: events.at(-1)?.id ?? 0,
    latestEventAt: events.at(-1)?.occurredAt,
    stale: false
  };
}
