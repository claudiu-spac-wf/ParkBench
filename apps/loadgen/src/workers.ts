import { ScenarioOperation } from "../../../packages/contracts/src/scenario";
import { LoadgenHttpClient, RequestResult } from "./http-client";
export async function runWorker(
  client: LoadgenHttpClient,
  select: () => ScenarioOperation,
  body: (operation: ScenarioOperation) => unknown,
  until: () => boolean,
  results: RequestResult[],
  onResult?: (result: RequestResult) => void | Promise<void>
): Promise<void> {
  while (!until()) {
    const operation = select();
    const result = await client.execute(operation, body(operation));
    results.push(result);
    await onResult?.(result);
  }
}
