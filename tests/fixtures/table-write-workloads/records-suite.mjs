import { run as creates } from "./creates-suite.mjs";
export async function run(context) {
  await creates(context);
  const { run: updates } = await import("./updates-suite.mjs");
  return updates(context);
}
