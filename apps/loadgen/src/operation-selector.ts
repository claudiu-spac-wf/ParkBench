import { ScenarioOperation } from "../../../packages/contracts/src/scenario";
export class OperationSelector {
  private readonly total: number;
  constructor(
    private readonly operations: ScenarioOperation[],
    private readonly random: () => number = Math.random
  ) {
    this.total = operations.reduce((sum, operation) => sum + operation.weight, 0);
  }
  next(): ScenarioOperation {
    let cursor = this.random() * this.total;
    for (const operation of this.operations) {
      cursor -= operation.weight;
      if (cursor <= 0) return operation;
    }
    return this.operations.at(-1)!;
  }
}
