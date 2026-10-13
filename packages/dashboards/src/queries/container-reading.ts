/** Native timestamps leave previous phase series visible during Prometheus lookback.
 * Select the freshest phase before aggregating physical containers. */
export function freshestContainerReading(
  selector: string,
  values: string = selector,
  dimensions = ""
): string {
  const identity =
    "run_id, id, service, container_label_com_docker_compose_service" +
    (dimensions ? `, ${dimensions}` : "");
  return `max by (${identity}) (${values} and (timestamp(${selector}) == on (${identity}) group_left max by (${identity}) (timestamp(${selector}))))`;
}
