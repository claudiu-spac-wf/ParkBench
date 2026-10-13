import { loadLoadgenConfig } from "./config";
import { runLoadgen } from "./runner";
import { EXIT_CODES } from "./exit-codes";
import { loadLocalEnvironment } from "../../../packages/contracts/src/local-env";
loadLocalEnvironment();
if (require.main === module) {
  let config;
  try {
    config = loadLoadgenConfig();
  } catch (error) {
    console.error(error);
    process.exitCode = EXIT_CODES.invalid;
  }
  if (config)
    runLoadgen(config)
      .then((summary) => {
        console.log(JSON.stringify(summary, null, 2));
        process.exitCode =
          summary.shutdownReason === "cancelled"
            ? EXIT_CODES.cancelled
            : summary.shutdownReason === "timeout" || summary.timeoutCount > 0
              ? EXIT_CODES.infrastructure
              : summary.thresholdFailed
                ? EXIT_CODES.threshold
                : EXIT_CODES.success;
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = /scenario|invalid|validation/i.test(String(error))
          ? EXIT_CODES.invalid
          : /target_unhealthy|observer|docker|prometheus/i.test(String(error))
            ? EXIT_CODES.infrastructure
            : EXIT_CODES.unexpected;
      });
}
