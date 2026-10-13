import { Direction, legend } from "./naming";
import { Target } from "./model";

/**
 * Builds the two directional targets required for every disk (Read/Write) and network
 * (In/Out) panel. Directional panels are only built through this helper, so no panel can
 * sum the two directions (FR-004, FR-006).
 */
export function directionalTargets(options: {
  kind: "disk" | "network";
  expr: (direction: Direction) => string;
  runPrefix: boolean;
  entity?: string;
}): Target[] {
  const directions: Direction[] = options.kind === "disk" ? ["Read", "Write"] : ["In", "Out"];
  return directions.map((direction) => ({
    expr: options.expr(direction),
    legendFormat: legend({ runPrefix: options.runPrefix, entity: options.entity, direction })
  }));
}
