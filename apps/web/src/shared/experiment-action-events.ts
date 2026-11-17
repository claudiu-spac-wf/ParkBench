// Tell other open ParkBench tabs to discard observations from the replaced execution.
const channel =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel("parkbench-experiment-actions");
export function announceExperimentAction(experimentId: string): void {
  channel?.postMessage({ experimentId });
}
export function onExperimentAction(listener: (experimentId: string) => void): () => void {
  const handler = (event: MessageEvent) => {
    if (typeof event.data?.experimentId === "string") listener(event.data.experimentId);
  };
  channel?.addEventListener("message", handler);
  return () => channel?.removeEventListener("message", handler);
}
