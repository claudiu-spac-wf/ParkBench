import { buildServer } from "./server";
import { loadConfig } from "../../../packages/contracts/src/config";
import { loadLocalEnvironment } from "../../../packages/contracts/src/local-env";
loadLocalEnvironment();
if (require.main === module) {
  const config = loadConfig();
  const app = buildServer();
  app.listen({ host: config.host, port: config.port }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
