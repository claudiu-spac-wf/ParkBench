import { createPlatform, Platform } from "./platform";
import { registerRoutes } from "./routes";
import Fastify from "fastify";
import cors from "@fastify/cors";
export function buildServer(platform = createPlatform()) {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 256 } });
  void app.register(cors, { origin: false });
  registerRoutes(app, platform);
  const startupRecovery = (platform as Platform & { startupRecovery?: Promise<number> })
    .startupRecovery;
  if (startupRecovery) app.addHook("onReady", async () => void (await startupRecovery));
  app.addHook("onReady", async () => void (await platform.discoveryReady));
  app.addHook("onClose", async () => platform.close());
  return app;
}
export { Platform };
